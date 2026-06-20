import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { NoWorkspaceError } from "@/lib/workspace";
import { runAgent, type Artifact } from "@/lib/agent/run";
import { checkChatRateLimit } from "@/lib/agent/rate-limit";
import { neutralizeMarkers, safeFilename } from "@/lib/agent/untrusted";
import type { ChatMessage, ContentBlock, ToolCall } from "@/lib/openrouter";

export const runtime = "nodejs";
// The agent loop can run several tool rounds + a long final generation. Give it
// the same generous ceiling as the voice route (Vercel Pro fluid compute).
export const maxDuration = 300;

// Attachment limits. GLM-5.1 is text-only: 'text' attachments are inlined as a
// delimited reference; 'file' attachments (PDF/doc) ride as a file content
// block that OpenRouter parses to text. Images/video are rejected in the UI.
const MAX_ATTACHMENTS = 5;
// ~10MB per file as a base64 data URL (base64 is ~1.33x the raw bytes).
const MAX_DATA_URL_LEN = 14_000_000;
const MAX_TEXT_LEN = 200_000; // inlined text-file cap (chars)
// Aggregate cap across all attachments in one request (~28MB of base64 ≈ 20MB
// raw), so a request body can't balloon into memory regardless of the per-file
// caps. The client enforces a friendlier 20MB; this is the hard backstop.
const MAX_TOTAL_ATTACHMENT_LEN = 28_000_000;

const attachmentSchema = z.object({
  kind: z.enum(["text", "file"]),
  filename: z.string().min(1).max(255),
  // For kind:'text' — the decoded text content (client reads it).
  text: z.string().max(MAX_TEXT_LEN).optional(),
  // For kind:'file' — a data: URL (e.g. data:application/pdf;base64,...).
  dataUrl: z.string().max(MAX_DATA_URL_LEN).optional(),
});

const bodySchema = z.object({
  message: z.string().trim().min(1).max(8000),
  attachments: z
    .array(attachmentSchema)
    .max(MAX_ATTACHMENTS)
    .optional()
    .refine(
      (atts) =>
        !atts ||
        atts.reduce(
          (n, a) => n + (a.dataUrl?.length ?? 0) + (a.text?.length ?? 0),
          0,
        ) <= MAX_TOTAL_ATTACHMENT_LEN,
      { message: "Attachments exceed the total size limit." },
    ),
});

type Attachment = z.infer<typeof attachmentSchema>;

type DbMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls: ToolCall[] | null;
  tool_call_id: string | null;
};

// -----------------------------------------------------------------------------
// POST /api/chats/[id]/stream
//
// Body: { message }. Persists the user message, runs the GLM-5.1 agent over the
// full transcript, and streams AgentEvents back as SSE. On completion persists
// the assistant turn (text + tool_calls + artifacts) and every tool result, and
// bumps the chat's updated_at (+ auto-titles it from the first user message).
// -----------------------------------------------------------------------------
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: chatId } = await params;

  // Resolve workspace + validate the chat up front (outside the stream) so auth
  // / not-found errors come back as normal JSON, not a half-open SSE stream.
  let workspaceId: string;
  let sbRaw: Awaited<ReturnType<typeof scopedSupabase>>["raw"];
  let userText: string;
  let attachments: Attachment[] = [];
  try {
    const sb = await scopedSupabase();
    workspaceId = sb.workspaceId;
    sbRaw = sb.raw;
    const body = bodySchema.parse(await req.json());
    userText = body.message;
    attachments = body.attachments ?? [];

    const { data: chat, error } = await sbRaw
      .from("chats")
      .select("id, title")
      .eq("id", chatId)
      .eq("workspace_id", workspaceId)
      .is("archived_at", null)
      .maybeSingle();
    if (error) throw error;
    if (!chat) {
      return jsonError("Chat not found", 404);
    }

    // Rate limit / cost cap BEFORE spending any tokens (and before persisting
    // the user message, so a rejected attempt doesn't count against the hourly
    // window). Returns 429 with a friendly message the UI surfaces as a toast.
    const limit = await checkChatRateLimit(workspaceId);
    if (!limit.ok) {
      return jsonError(
        limit.message,
        429,
        limit.retryAfterSec
          ? { "Retry-After": String(limit.retryAfterSec) }
          : undefined,
      );
    }

    // Persist the user message. We store the typed text plus a compact note of
    // any attached filenames (not the file bytes — those are consumed this turn
    // only) so the transcript shows "📎 brief.pdf" on reload.
    const fileNote = attachments.length
      ? `\n\n📎 Attached: ${attachments.map((a) => safeFilename(a.filename)).join(", ")}`
      : "";
    await sbRaw.from("chat_messages").insert({
      chat_id: chatId,
      workspace_id: workspaceId,
      role: "user",
      content: userText + fileNote,
    });

    // Auto-title from the first user message if still the default. The
    // `.eq("title", "New chat")` makes this atomic: it only titles when the DB
    // row is STILL the default, so a concurrent user rename is never clobbered
    // (the stale in-memory chat.title is just a cheap pre-check).
    if (chat.title === "New chat") {
      const title = userText.replace(/\s+/g, " ").slice(0, 60).trim();
      if (title) {
        await sbRaw
          .from("chats")
          .update({ title, updated_at: new Date().toISOString() })
          .eq("id", chatId)
          .eq("workspace_id", workspaceId)
          .eq("title", "New chat");
      }
    }
  } catch (e) {
    if (e instanceof NoWorkspaceError) return jsonError(e.message, 400);
    if (e instanceof z.ZodError) return jsonError("Invalid request body", 400);
    return jsonError((e as Error)?.message ?? "Unexpected error", 500);
  }

  // Load prior transcript (excluding the message we just inserted is fine —
  // include it; it's the latest user turn the agent should answer).
  const { data: rows } = await sbRaw
    .from("chat_messages")
    .select("role, content, tool_calls, tool_call_id")
    .eq("chat_id", chatId)
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true });

  const history: ChatMessage[] = ((rows ?? []) as DbMessage[]).map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
  }));

  // Attach this turn's files to the final user message. The persisted row only
  // carries the filename note; the actual content (text inlined, PDFs as file
  // blocks for OpenRouter to parse) is consumed in-flight and not stored.
  if (attachments.length) {
    const blocks: ContentBlock[] = [{ type: "text", text: userText }];
    for (const a of attachments) {
      if (a.kind === "text" && a.text) {
        // Inline text files as a delimited reference the agent treats as data.
        // Untrusted: neutralize any forged markers in the body, and sanitize the
        // filename (it sits on the marker line itself).
        blocks.push({
          type: "text",
          text: `\n\n--- ATTACHED FILE: ${safeFilename(a.filename)} ---\n${neutralizeMarkers(a.text)}\n--- END FILE ---`,
        });
      } else if (a.kind === "file" && a.dataUrl) {
        blocks.push({
          type: "file",
          file: { filename: a.filename, file_data: a.dataUrl },
        });
      }
    }
    // Replace the last user turn (the one we just persisted) with the rich one.
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === "user") {
        history[i] = { role: "user", content: blocks };
        break;
      }
    }
  }

  const encoder = new TextEncoder();
  const send = (
    controller: ReadableStreamDefaultController,
    event: string,
    data: unknown,
  ) => {
    controller.enqueue(
      encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    );
  };

  const stream = new ReadableStream({
    async start(controller) {
      const artifacts: Artifact[] = [];
      // Accumulate streamed text + whether we've already persisted the assistant
      // turn, so an error/abort mid-stream still saves a row (otherwise the user
      // message is orphaned with no reply, which corrupts the next turn's
      // history).
      let streamedText = "";
      let persisted = false;
      const persistAssistant = async (
        content: string,
        toolCalls: ToolCall[] | null,
        tokens?: { input: number; output: number },
        toolMessages?: { content: string; tool_call_id: string | null }[],
      ) => {
        if (persisted) return;
        persisted = true;
        if (toolMessages?.length) {
          await sbRaw.from("chat_messages").insert(
            toolMessages.map((t) => ({
              chat_id: chatId,
              workspace_id: workspaceId,
              role: "tool" as const,
              content: t.content ?? "",
              tool_call_id: t.tool_call_id ?? null,
            })),
          );
        }
        await sbRaw.from("chat_messages").insert({
          chat_id: chatId,
          workspace_id: workspaceId,
          role: "assistant",
          content,
          tool_calls: toolCalls,
          artifacts: artifacts.length ? artifacts : null,
          input_tokens: tokens?.input ?? null,
          output_tokens: tokens?.output ?? null,
        });
        await sbRaw
          .from("chats")
          .update({ updated_at: new Date().toISOString() })
          .eq("id", chatId)
          .eq("workspace_id", workspaceId);
      };
      try {
        for await (const ev of runAgent({
          history,
          workspaceId,
          signal: req.signal,
        })) {
          switch (ev.type) {
            case "text":
              streamedText += ev.delta;
              send(controller, "text", { delta: ev.delta });
              break;
            case "tool_start":
              send(controller, "tool_start", {
                id: ev.id,
                name: ev.name,
                args: ev.args,
              });
              break;
            case "tool_end":
              send(controller, "tool_end", {
                id: ev.id,
                name: ev.name,
                ok: ev.ok,
              });
              break;
            case "artifact":
              artifacts.push(ev.artifact);
              send(controller, "artifact", ev.artifact);
              break;
            case "done": {
              await persistAssistant(
                ev.message.content,
                ev.message.tool_calls,
                {
                  input: ev.message.inputTokens,
                  output: ev.message.outputTokens,
                },
                ev.message.toolMessages.map((t) => ({
                  // Tool messages always carry string content.
                  content: typeof t.content === "string" ? t.content : "",
                  tool_call_id: t.tool_call_id ?? null,
                })),
              );
              send(controller, "done", { artifacts });
              break;
            }
            case "error":
              // Save whatever streamed so the user message isn't left orphaned.
              await persistAssistant(
                streamedText ||
                  "⚠️ The assistant hit an error and couldn't finish this response.",
                null,
              );
              send(controller, "error", { message: ev.message });
              break;
          }
        }
      } catch (e) {
        // Thrown mid-stream (incl. client abort): persist the partial so the
        // turn isn't lost, then surface the error.
        await persistAssistant(
          streamedText ||
            "⚠️ The assistant hit an error and couldn't finish this response.",
          null,
        ).catch(() => {});
        send(controller, "error", { message: (e as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

function jsonError(
  message: string,
  status: number,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...(extraHeaders ?? {}) },
  });
}
