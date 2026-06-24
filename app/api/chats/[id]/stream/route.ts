import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { NoWorkspaceError } from "@/lib/workspace";
import { runAgent, type Artifact } from "@/lib/agent/run";
import { checkChatRateLimit, claimChatTurn } from "@/lib/agent/rate-limit";
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
  // "Model this post": the stashed source id (chat_modeling_sources). The server
  // fetches + weaves the post text, so a long post never hits the message cap.
  modelSourceId: z.string().uuid().optional(),
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
  let modelSourceId: string | undefined;
  try {
    const sb = await scopedSupabase();
    workspaceId = sb.workspaceId;
    sbRaw = sb.raw;
    const body = bodySchema.parse(await req.json());
    userText = body.message;
    attachments = body.attachments ?? [];
    modelSourceId = body.modelSourceId;

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

    // Monthly cost cap first (fail-closed money ceiling). The hourly/daily count
    // caps + the user-message insert happen atomically in claimChatTurn below.
    const cost = await checkChatRateLimit(workspaceId);
    if (!cost.ok) {
      return jsonError(
        cost.message,
        429,
        cost.retryAfterSec ? { "Retry-After": String(cost.retryAfterSec) } : undefined,
      );
    }

    // Atomically check the count caps AND persist the user message in one
    // locked transaction, so concurrent requests can't all slip past the caps.
    // We store the typed text + a compact note of attached filenames (not the
    // file bytes — those are consumed this turn only).
    const fileNote = attachments.length
      ? `\n\n📎 Attached: ${attachments.map((a) => safeFilename(a.filename)).join(", ")}`
      : "";
    const claim = await claimChatTurn(workspaceId, chatId, userText + fileNote);
    if (!claim.ok) {
      return jsonError(
        claim.message,
        429,
        claim.retryAfterSec ? { "Retry-After": String(claim.retryAfterSec) } : undefined,
      );
    }

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

  // Weave the "Model this post" source + this turn's files into the final user
  // message the agent sees. The persisted user row stays clean (just the typed
  // text + a filename note) — this rich content is consumed in-flight only, so
  // a long modeled post never hits the 8000-char message cap and a reloaded
  // transcript never shows the raw delimiter blob.
  const blocks: ContentBlock[] = [{ type: "text", text: userText }];

  if (modelSourceId) {
    const { data: src } = await sbRaw
      .from("chat_modeling_sources")
      .select("post_text")
      .eq("id", modelSourceId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    const postText = (src?.post_text as string | null)?.trim();
    if (postText) {
      // Already neutralized at stash time; neutralize again (idempotent) so the
      // envelope is safe even if the row predates that fix.
      blocks.push({
        type: "text",
        text: `\n\n--- POST TO MODEL AFTER ---\n${neutralizeMarkers(postText)}\n--- END POST ---`,
      });
    }
  }

  for (const a of attachments) {
    if (a.kind === "text" && a.text) {
      // Inline text files as a delimited reference the agent treats as data.
      // Untrusted: neutralize forged markers in the body, sanitize the filename.
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

  // Replace the last user turn with the rich content (only if we added anything
  // beyond the plain text).
  if (blocks.length > 1) {
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
        // Persist cite artifacts as a bare postId reference — drop the resolved
        // meta.card snapshot. Engagement counts drift and LinkedIn media URLs
        // expire (~weekly), so the card is RE-RESOLVED fresh on chat load
        // rather than stored stale. post/hook artifacts persist as-is.
        const persistArtifacts = artifacts.map((a) =>
          a.kind === "cite"
            ? { ...a, meta: { postId: (a.meta as { postId?: string })?.postId } }
            : a,
        );
        await sbRaw.from("chat_messages").insert({
          chat_id: chatId,
          workspace_id: workspaceId,
          role: "assistant",
          content,
          tool_calls: toolCalls,
          artifacts: persistArtifacts.length ? persistArtifacts : null,
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
              // RECOVERABLE errors (length_truncated, tool_budget_exhausted)
              // are followed by a `done` event with the proper finalText —
              // skip persisting here and let `done` carry the canonical
              // content. The error frame is purely a UI signal (show the
              // Continue button). Non-recoverable errors (provider 5xx,
              // rate limits, content filter) DON'T get a `done` event, so we
              // persist here to make sure the user's turn isn't orphaned.
              if (!ev.recovery) {
                await persistAssistant(
                  streamedText ||
                    "⚠️ The assistant hit an error and couldn't finish this response.",
                  null,
                );
              }
              send(controller, "error", {
                message: ev.message,
                code: ev.code,
                recovery: ev.recovery,
              });
              break;
          }
        }
      } catch (e) {
        // Thrown mid-stream (incl. client abort): persist the partial so the
        // turn isn't lost, then surface the error (preserving any provider
        // error code so the client can render a specific message).
        await persistAssistant(
          streamedText ||
            "⚠️ The assistant hit an error and couldn't finish this response.",
          null,
        ).catch(() => {});
        const err = e as Error & { code?: string | number };
        send(controller, "error", { message: err.message, code: err.code });
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
