import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { NoWorkspaceError } from "@/lib/workspace";
import { runAgent, type Artifact } from "@/lib/agent/run";
import { checkChatRateLimit } from "@/lib/agent/rate-limit";
import type { ChatMessage, ToolCall } from "@/lib/openrouter";

export const runtime = "nodejs";
// The agent loop can run several tool rounds + a long final generation. Give it
// the same generous ceiling as the voice route (Vercel Pro fluid compute).
export const maxDuration = 300;

const bodySchema = z.object({
  message: z.string().trim().min(1).max(8000),
});

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
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: chatId } = await params;

  // Resolve workspace + validate the chat up front (outside the stream) so auth
  // / not-found errors come back as normal JSON, not a half-open SSE stream.
  let workspaceId: string;
  let sbRaw: Awaited<ReturnType<typeof scopedSupabase>>["raw"];
  let userText: string;
  try {
    const sb = await scopedSupabase();
    workspaceId = sb.workspaceId;
    sbRaw = sb.raw;
    const body = bodySchema.parse(await req.json());
    userText = body.message;

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
        limit.retryAfterSec ? { "Retry-After": String(limit.retryAfterSec) } : undefined,
      );
    }

    // Persist the user message immediately.
    await sbRaw.from("chat_messages").insert({
      chat_id: chatId,
      workspace_id: workspaceId,
      role: "user",
      content: userText,
    });

    // Auto-title from the first user message if still the default.
    if (chat.title === "New chat") {
      const title = userText.replace(/\s+/g, " ").slice(0, 60).trim();
      await sbRaw
        .from("chats")
        .update({ title: title || "New chat", updated_at: new Date().toISOString() })
        .eq("id", chatId)
        .eq("workspace_id", workspaceId);
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
      try {
        for await (const ev of runAgent({
          history,
          workspaceId,
          signal: req.signal,
        })) {
          switch (ev.type) {
            case "text":
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
              send(controller, "tool_end", { id: ev.id, name: ev.name, ok: ev.ok });
              break;
            case "artifact":
              artifacts.push(ev.artifact);
              send(controller, "artifact", ev.artifact);
              break;
            case "done": {
              // Persist tool messages first (FK-free, just transcript), then the
              // assistant turn carrying tool_calls + artifacts.
              const toPersist = ev.message.toolMessages.map((t) => ({
                chat_id: chatId,
                workspace_id: workspaceId,
                role: "tool" as const,
                content: t.content ?? "",
                tool_call_id: t.tool_call_id ?? null,
              }));
              if (toPersist.length) {
                await sbRaw.from("chat_messages").insert(toPersist);
              }
              await sbRaw.from("chat_messages").insert({
                chat_id: chatId,
                workspace_id: workspaceId,
                role: "assistant",
                content: ev.message.content,
                tool_calls: ev.message.tool_calls,
                artifacts: artifacts.length ? artifacts : null,
                input_tokens: ev.message.inputTokens,
                output_tokens: ev.message.outputTokens,
              });
              await sbRaw
                .from("chats")
                .update({ updated_at: new Date().toISOString() })
                .eq("id", chatId)
                .eq("workspace_id", workspaceId);
              send(controller, "done", { artifacts });
              break;
            }
            case "error":
              send(controller, "error", { message: ev.message });
              break;
          }
        }
      } catch (e) {
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
