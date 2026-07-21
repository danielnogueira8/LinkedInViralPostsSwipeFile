import type { SupabaseClient } from "@supabase/supabase-js";
import { executeChatTurn } from "@/lib/agent/chat-turn";
import type { scopedSupabase } from "@/lib/supabase-scoped";
import { neutralizeMarkers } from "@/lib/agent/untrusted";
import { DraftLifecycle } from "@/lib/draft-lifecycle";
import { createSupabaseDraftLifecycleRepository } from "@/lib/draft-lifecycle-supabase";

// ---------------------------------------------------------------------------
// Agent loop actor (PLAN-agent-loop Phase D3).
//
// Turns the top proposed opportunities into real drafts by running the SAME
// chat turn pipeline server-side, into a per-workspace system chat ("Your
// agent"). Generated posts are also saved to the board via the normal
// saveFromChat lifecycle so they appear in one place. Fail-open per
// opportunity: a failed turn leaves the opportunity proposed so it can retry.
// ---------------------------------------------------------------------------

const SYSTEM_CHAT_TITLE = "Your agent";
const ACT_TIMEOUT_MS = 240_000;

export type AgentOpportunityRow = {
  id: string;
  source_post_id: string | null;
  payload: {
    headline?: string;
    author?: string;
    metrics?: { viral_score?: number; reactions?: number; comments?: number };
  } | null;
};

async function getOrCreateSystemChat(
  sb: SupabaseClient,
  workspaceId: string,
): Promise<string> {
  const { data: existing, error: existingError } = await sb
    .from("chats")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("title", SYSTEM_CHAT_TITLE)
    .is("archived_at", null)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing?.id) return existing.id as string;

  const { data: created, error: createError } = await sb
    .from("chats")
    .insert({ workspace_id: workspaceId, title: SYSTEM_CHAT_TITLE })
    .select("id")
    .single();
  if (createError) throw createError;
  return created.id as string;
}

async function createModelingSource(
  sb: SupabaseClient,
  workspaceId: string,
  postId: string,
): Promise<string | null> {
  const { data: post, error } = await sb
    .from("posts")
    .select("id, text, post_type, accounts(name)")
    .eq("id", postId)
    .maybeSingle();
  if (error) throw error;
  const text = (post?.text as string | null) ?? "";
  if (!text.trim()) return null;
  const acc = Array.isArray(post?.accounts)
    ? post?.accounts[0]
    : post?.accounts;
  const { data: source, error: insertError } = await sb
    .from("chat_modeling_sources")
    .insert({
      workspace_id: workspaceId,
      post_text: neutralizeMarkers(text),
      author_name: (acc?.name as string | null) ?? null,
      source: "swipe",
      source_post_id: postId,
      post_type: post?.post_type === "lead_magnet" ? "lead_magnet" : "regular",
    })
    .select("id")
    .single();
  if (insertError) throw insertError;
  return source.id as string;
}

async function saveChatArtifactsToBoard(
  sb: SupabaseClient,
  workspaceId: string,
  chatId: string,
  turnStartedAt: string,
): Promise<string[]> {
  // Only artifacts from THIS turn. The agent chat accumulates turns, so an
  // unscoped "latest assistant with artifacts" read could re-save a previous
  // turn's draft and mark this opportunity drafted even though this turn
  // produced nothing.
  const { data: message, error } = await sb
    .from("chat_messages")
    .select("artifacts")
    .eq("chat_id", chatId)
    .eq("workspace_id", workspaceId)
    .eq("role", "assistant")
    .not("artifacts", "is", null)
    .gte("created_at", turnStartedAt)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const artifacts = (message?.artifacts as Array<{
    id?: string;
    kind?: string;
    body?: string;
    title?: string;
    meta?: Record<string, unknown>;
  }> | null) ?? [];
  const lifecycle = new DraftLifecycle(
    createSupabaseDraftLifecycleRepository(sb, workspaceId),
  );
  const draftIds: string[] = [];
  for (const artifact of artifacts) {
    if (artifact.kind !== "post" || typeof artifact.body !== "string") continue;
    const outcome = await lifecycle.saveFromChat({
      chatId,
      body: artifact.body,
      title: artifact.title,
      kind: "post",
      meta: artifact.meta ?? undefined,
    });
    if (outcome.ok) draftIds.push(outcome.value.draft.id);
  }
  return draftIds;
}

export async function actOnOpportunity(
  sb: SupabaseClient,
  workspaceId: string,
  opportunity: AgentOpportunityRow,
): Promise<{ ok: true; draftIds: string[] } | { ok: false; reason: string }> {
  if (!opportunity.source_post_id) {
    return { ok: false, reason: "missing_source" };
  }

  await sb
    .from("agent_opportunities")
    .update({ status: "drafting" })
    .eq("id", opportunity.id)
    .eq("workspace_id", workspaceId);

  try {
    const modelSourceId = await createModelingSource(
      sb,
      workspaceId,
      opportunity.source_post_id,
    );
    if (!modelSourceId) {
      throw new Error("Could not load the source post text.");
    }
    const chatId = await getOrCreateSystemChat(sb, workspaceId);
    const turnStartedAt = new Date().toISOString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ACT_TIMEOUT_MS);
    try {
      const headline =
        typeof opportunity.payload?.headline === "string"
          ? opportunity.payload.headline
          : "Model this post.";
      const result = await executeChatTurn(
        {
          chatId,
          userId: workspaceId,
          body: {
            message: `${headline}\n\nWrite one post in my voice modeled on the attached source.`,
            modelSourceId,
          },
          signal: controller.signal,
        },
        {
          // The cron has no Clerk session, so the default scopedSupabase (which
          // resolves the workspace from auth) would throw before the turn
          // starts. Pin the workspace + service-role client explicitly; setup
          // only reads `.workspaceId` and `.raw`.
          scopedSupabase: (async () => ({
            workspaceId,
            raw: sb,
          })) as unknown as typeof scopedSupabase,
        },
      );
      if (result instanceof Response) {
        const bodyText = await result.text().catch(() => "");
        throw new Error(
          `Chat turn failed with status ${result.status}: ${bodyText.slice(0, 200)}`,
        );
      }
      const outcome = await result.terminal;
      if (outcome.terminal !== "done") {
        throw new Error(
          `Chat turn ended as ${outcome.terminal}${
            outcome.error ? `: ${outcome.error.message}` : ""
          }`,
        );
      }
      const draftIds = await saveChatArtifactsToBoard(
        sb,
        workspaceId,
        chatId,
        turnStartedAt,
      );
      if (draftIds.length === 0) {
        throw new Error("Chat turn produced no draft artifact.");
      }
      await sb
        .from("agent_opportunities")
        .update({
          status: "drafted",
          drafted_artifact_id: draftIds[0],
          acted_at: new Date().toISOString(),
        })
        .eq("id", opportunity.id)
        .eq("workspace_id", workspaceId);
      return { ok: true, draftIds };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    // Leave the opportunity proposed so the next run retries it once; the
    // scanner's 5-day expiry eventually cleans it up.
    await sb
      .from("agent_opportunities")
      .update({ status: "proposed" })
      .eq("id", opportunity.id)
      .eq("workspace_id", workspaceId);
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
