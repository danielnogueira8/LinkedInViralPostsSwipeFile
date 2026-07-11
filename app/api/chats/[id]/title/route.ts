import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { completeChat, CHAT_MODEL, logOpenRouterUsage } from "@/lib/openrouter";
import { checkChatRateLimit } from "@/lib/agent/rate-limit";
import { neutralizeMarkers } from "@/lib/agent/untrusted";
import {
  claimAiOperation,
  releaseAiOperation,
} from "@/lib/ai-operation-claims";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

// -----------------------------------------------------------------------------
// POST /api/chats/[id]/title — auto-name a chat from its first exchange.
//
// Called by the client once the first turn completes (while the title is still
// the default "New chat"). A single cheap GLM-5.2 call turns the first user
// message + first assistant reply into a 3-5 word title, so the history is
// scannable instead of a wall of starter-prompt prefixes.
//
// Idempotent-ish: only (re)titles a chat whose title is still "New chat" (or
// empty), so a user's manual rename is never overwritten. Cost is logged to
// usage_events under kind 'chat-title' so it counts toward the workspace budget.
// -----------------------------------------------------------------------------
const TITLE_SYSTEM =
  "You name chat threads. Given the first user message and the assistant's reply, " +
  "produce a SHORT title of 3 to 6 words that captures the topic. Plain text only: " +
  "no quotes, no trailing punctuation, no emoji, Title Case. Examples: " +
  "Cold outreach hooks, GTM strategy post, Lead magnet breakdown, Five viral hook ideas.";

// Strip anything the model wraps the title in, and hard-cap the length.
function cleanTitle(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/^["'`*\s]+|["'`*.\s]+$/g, "")
    .slice(0, 60)
    .trim();
}

export async function POST(_req: Request, { params }: Ctx) {
  let operationClaim: { workspaceId: string; claimId: string } | null = null;
  try {
    const { id } = await params;
    const sb = await scopedSupabase();

    // Confirm the chat is ours and still untitled (don't clobber a manual name).
    const { data: chat, error: chatErr } = await sb.raw
      .from("chats")
      .select("id, title")
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
      .is("archived_at", null)
      .maybeSingle();
    if (chatErr) throw chatErr;
    if (!chat) {
      return NextResponse.json({ ok: false, error: "Chat not found" }, { status: 404 });
    }
    const current = (chat.title as string | null) ?? "";
    if (current && current !== "New chat") {
      // Already named (auto or manual) — nothing to do.
      return NextResponse.json({ ok: true, title: current, skipped: true });
    }

    // The read above is not a concurrency boundary: two title requests can
    // both observe "New chat" and both pay for the same model call. Claim the
    // chat before reading its messages. A loser returns the current/default
    // title while the winner finishes; the client already treats this endpoint
    // as best-effort.
    const claimId = await claimAiOperation({
      workspaceId: sb.workspaceId,
      operationKey: `chat-title:${id}`,
      ttlSeconds: 5 * 60,
    });
    if (!claimId) {
      return NextResponse.json({ ok: true, title: current || "New chat", skipped: true });
    }
    operationClaim = { workspaceId: sb.workspaceId, claimId };

    // A request may have read "New chat" before another request completed and
    // released its claim. Re-check after acquiring so stale readers never pay.
    const { data: claimedChat, error: claimedChatErr } = await sb.raw
      .from("chats")
      .select("title")
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
      .is("archived_at", null)
      .maybeSingle();
    if (claimedChatErr) throw claimedChatErr;
    const claimedTitle = String(claimedChat?.title ?? "");
    if (claimedTitle && claimedTitle !== "New chat") {
      return NextResponse.json({ ok: true, title: claimedTitle, skipped: true });
    }

    // First user message + first assistant reply.
    const { data: msgs, error: msgErr } = await sb.raw
      .from("chat_messages")
      .select("role, content")
      .eq("chat_id", id)
      .eq("workspace_id", sb.workspaceId)
      .in("role", ["user", "assistant"])
      .order("created_at", { ascending: true })
      .limit(6);
    if (msgErr) throw msgErr;
    const firstUser = (msgs ?? []).find((m) => m.role === "user");
    const firstAssistant = (msgs ?? []).find((m) => m.role === "assistant");
    if (!firstUser) {
      // No conversation yet — leave the default.
      return NextResponse.json({ ok: true, title: current || "New chat", skipped: true });
    }

    // Cost-cap gate. Auto-titling spends a (tiny) GLM call, and this was the one
    // spend path NOT behind the monthly cap — so a workspace over its budget
    // still incurred title cost, making the ceiling not quite inviolable. Skip
    // titling when over the cap rather than spend past it; the chat just keeps
    // its "New chat" default until the cap resets. (Magnitude is cents, but the
    // cap should hold everywhere on principle.)
    const cap = await checkChatRateLimit(sb.workspaceId);
    if (!cap.ok) {
      return NextResponse.json({ ok: true, title: current || "New chat", skipped: true });
    }

    // Both sides are treated as DATA (neutralize any forged markers), and we cap
    // the context we send so a giant first message stays a cheap call.
    const userText = neutralizeMarkers(String(firstUser.content ?? "")).slice(0, 1200);
    const asstText = neutralizeMarkers(String(firstAssistant?.content ?? "")).slice(0, 800);

    const { text, usage } = await completeChat({
      model: CHAT_MODEL,
      maxTokens: 24,
      messages: [
        { role: "system", content: TITLE_SYSTEM },
        {
          role: "user",
          content:
            `First user message:\n${userText}\n\n` +
            (asstText ? `Assistant reply:\n${asstText}\n\n` : "") +
            "Title:",
        },
      ],
    });

    // Attribute the (tiny) cost to the workspace. Awaited so the cost is
    // committed before the response returns (consistent with every other
    // logOpenRouterUsage call site — see the no-void lint rule).
    await logOpenRouterUsage("chat-title", CHAT_MODEL, usage, sb.workspaceId);

    const title = cleanTitle(text);
    if (!title) {
      return NextResponse.json({ ok: true, title: current || "New chat", skipped: true });
    }

    // Only update if still untitled (re-check via the filter so a concurrent
    // manual rename isn't clobbered). updated_at is left alone so titling doesn't
    // bump the chat's position in the recency-sorted history.
    const { data: updated, error: updErr } = await sb.raw
      .from("chats")
      .update({ title })
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
      .eq("title", "New chat")
      .select("id, title")
      .maybeSingle();
    if (updErr) throw updErr;

    return NextResponse.json({ ok: true, title: updated?.title ?? title });
  } catch (e) {
    return errorResponse(e);
  } finally {
    if (operationClaim) {
      await releaseAiOperation(operationClaim).catch(() => {});
    }
  }
}
