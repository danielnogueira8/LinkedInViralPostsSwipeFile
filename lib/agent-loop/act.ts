import type { SupabaseClient } from "@supabase/supabase-js";
import { executeChatTurn } from "@/lib/agent/chat-turn";
import type { scopedSupabase } from "@/lib/supabase-scoped";
import { neutralizeMarkers } from "@/lib/agent/untrusted";
import { DraftLifecycle } from "@/lib/draft-lifecycle";
import { createSupabaseDraftLifecycleRepository } from "@/lib/draft-lifecycle-supabase";
import { AGENT_CHAT_TITLE, AGENT_SUGGESTED_BY } from "@/lib/agent-loop/constants";
import { readOpportunityHeadline } from "@/lib/agent-loop/headline";
import {
  LEAD_MAGNET_COLS,
  coerceLeadMagnet,
  selectLeadMagnetForPrompt,
  type LeadMagnet,
} from "@/lib/lead-magnets";
import { leadMagnetSelectionPromptBeforeDraft } from "@/lib/lead-magnet-campaign";
import type { PostType } from "@/lib/post-type";

// ---------------------------------------------------------------------------
// Agent loop actor (PLAN-agent-loop Phase D3).
//
// Turns the top proposed opportunities into real drafts by running the SAME
// chat turn pipeline server-side, into a per-workspace system chat ("Your
// agent"). Generated posts are also saved to the board via the normal
// saveFromChat lifecycle so they appear in one place. Fail-open per
// opportunity: a failed turn leaves the opportunity proposed so it can retry.
// ---------------------------------------------------------------------------

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

type OpportunityStatusPolicy = "manage" | "preserve";

async function updateOpportunityStatus(
  sb: SupabaseClient,
  workspaceId: string,
  opportunityId: string,
  policy: OpportunityStatusPolicy,
  values: Record<string, unknown>,
): Promise<void> {
  if (policy === "preserve") return;
  await sb
    .from("agent_opportunities")
    .update(values)
    .eq("id", opportunityId)
    .eq("workspace_id", workspaceId);
}

async function getOrCreateSystemChat(
  sb: SupabaseClient,
  workspaceId: string,
): Promise<string> {
  const { data: existing, error: existingError } = await sb
    .from("chats")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("title", AGENT_CHAT_TITLE)
    .is("archived_at", null)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing?.id) return existing.id as string;

  const { data: created, error: createError } = await sb
    .from("chats")
    .insert({ workspace_id: workspaceId, title: AGENT_CHAT_TITLE })
    .select("id")
    .single();
  if (createError) throw createError;
  return created.id as string;
}

async function createModelingSource(
  sb: SupabaseClient,
  workspaceId: string,
  postId: string,
): Promise<{ id: string; postType: PostType; postText: string } | null> {
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
  const postType: PostType =
    post?.post_type === "lead_magnet" ? "lead_magnet" : "regular";
  const { data: source, error: insertError } = await sb
    .from("chat_modeling_sources")
    .insert({
      workspace_id: workspaceId,
      post_text: neutralizeMarkers(text),
      author_name: (acc?.name as string | null) ?? null,
      source: "swipe",
      source_post_id: postId,
      post_type: postType,
    })
    .select("id")
    .single();
  if (insertError) throw insertError;
  return { id: source.id as string, postType, postText: text };
}

/**
 * A modeled lead-magnet post needs a resource to promote (the turn pipeline
 * fails closed without one). Pick the workspace's best-fit saved lead magnet
 * for this source; when the user has none, ask the pipeline to generate one
 * from the source post's promise.
 */
async function leadMagnetForTurn(
  sb: SupabaseClient,
  workspaceId: string,
  headline: string,
  postText: string,
): Promise<
  | { leadMagnetId: string }
  | { createLeadMagnet: { prompt: string } }
> {
  const { data: rows, error } = await sb
    .from("lead_magnets")
    .select(LEAD_MAGNET_COLS)
    .eq("workspace_id", workspaceId)
    .order("updated_at", { ascending: false })
    .limit(30);
  if (error) throw error;
  const candidates = ((rows ?? []) as LeadMagnet[]).map(coerceLeadMagnet);
  const selected = selectLeadMagnetForPrompt(
    leadMagnetSelectionPromptBeforeDraft({
      userText: headline,
      sourceText: postText,
    }),
    candidates,
  );
  if (selected) return { leadMagnetId: selected.id };
  return {
    createLeadMagnet: {
      prompt:
        "Create a lead magnet resource this post can promote. Base it on the promise of the source post below — same topic, rewritten as the user's own resource.\n\n" +
        postText.slice(0, 600),
    },
  };
}

async function saveChatArtifactsToBoard(
  sb: SupabaseClient,
  workspaceId: string,
  chatId: string,
  turnStartedAt: string,
  opportunityId?: string,
  isLeadMagnet?: boolean,
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
      kind: isLeadMagnet ? "lead_magnet" : "post",
      // Stamp agent provenance so the board can badge + filter these drafts
      // (Phase E3) without a new status column.
      meta: {
        ...(artifact.meta ?? {}),
        suggested_by: AGENT_SUGGESTED_BY,
        ...(opportunityId ? { agent_opportunity_id: opportunityId } : {}),
      },
    });
    if (outcome.ok) draftIds.push(outcome.value.draft.id);
  }
  return draftIds;
}

/** Run ONE chat turn into the agent's system chat and save its post artifacts
 *  to the board. Shared by opportunity drafting and generic plan-day prompts. */
async function runTurnToDraftIds(
  sb: SupabaseClient,
  workspaceId: string,
  body: {
    message: string;
    modelSourceId?: string;
    leadMagnetId?: string;
    createLeadMagnet?: { prompt: string };
  },
  opportunityId?: string,
): Promise<string[]> {
  const chatId = await getOrCreateSystemChat(sb, workspaceId);
  const turnStartedAt = new Date().toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ACT_TIMEOUT_MS);
  try {
    const result = await executeChatTurn(
      {
        chatId,
        userId: workspaceId,
        // Weekly-plan cards are explicit creation controls, just like the
        // Cowork composer in Create mode. Without this command the turn falls
        // into the rolling-deploy commandless compatibility lane, where the
        // answer router can clarify instead of producing the requested post.
        body: {
          ...body,
          command: { kind: "create", count: 1 },
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
      opportunityId,
      Boolean(body.leadMagnetId || body.createLeadMagnet),
    );
    if (draftIds.length === 0) {
      throw new Error("Chat turn produced no draft artifact.");
    }
    return draftIds;
  } finally {
    clearTimeout(timeout);
  }
}

export async function actOnOpportunity(
  sb: SupabaseClient,
  workspaceId: string,
  opportunity: AgentOpportunityRow,
  direction?: {
    userContext?: string;
    leadMagnetId?: string;
  },
  options?: {
    statusPolicy?: OpportunityStatusPolicy;
  },
): Promise<{ ok: true; draftIds: string[] } | { ok: false; reason: string }> {
  if (!opportunity.source_post_id) {
    return { ok: false, reason: "missing_source" };
  }

  const statusPolicy = options?.statusPolicy ?? "manage";
  await updateOpportunityStatus(
    sb,
    workspaceId,
    opportunity.id,
    statusPolicy,
    { status: "drafting" },
  );

  try {
    const source = await createModelingSource(
      sb,
      workspaceId,
      opportunity.source_post_id,
    );
    if (!source) {
      throw new Error("Could not load the source post text.");
    }
    // Read through the normaliser: this string is fed to the model as the
    // user turn, so a stale "<creator> went 2530×" payload would teach the
    // draft a false claim about the creator, not just render badly.
    const headline =
      typeof opportunity.payload?.headline === "string"
        ? readOpportunityHeadline(opportunity.payload)
        : "Model this post.";
    // Lead-magnet source: attach a resource so the modeled giveaway post can
    // actually promote something — the best-fit saved lead magnet, or a
    // freshly generated one when the user has none (issue #2: previously the
    // turn failed closed with "Select or create a lead magnet").
    const leadMagnetContext =
      source.postType === "lead_magnet"
        ? direction?.leadMagnetId
          ? { leadMagnetId: direction.leadMagnetId }
          : await leadMagnetForTurn(sb, workspaceId, headline, source.postText)
        : null;
    const userDirection = direction?.userContext?.trim();
    const draftIds = await runTurnToDraftIds(
      sb,
      workspaceId,
      {
        message:
          `${headline}\n\nWrite one post in my voice modeled on the attached source.` +
          (userDirection
            ? `\n\nFollow this direction from the user:\n${userDirection}`
            : ""),
        modelSourceId: source.id,
        ...(leadMagnetContext ?? {}),
      },
      opportunity.id,
    );
    await updateOpportunityStatus(
      sb,
      workspaceId,
      opportunity.id,
      statusPolicy,
      {
        status: "drafted",
        drafted_artifact_id: draftIds[0],
        acted_at: new Date().toISOString(),
      },
    );
    return { ok: true, draftIds };
  } catch (error) {
    // Managed feed work returns to proposed so it can retry. Cadence work
    // preserves a prior feed dismissal, keeping the two surfaces independent.
    await updateOpportunityStatus(
      sb,
      workspaceId,
      opportunity.id,
      statusPolicy,
      { status: "proposed" },
    );
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Draft from a generic plan-day prompt (Phase F v2) — no source attached. The
 * prompt is the under-the-hood instruction behind a "your story" plan day
 * ("talk about a recent client win"); the normal original-post pipeline
 * (structure matcher + voice + learnings) writes it.
 */
export async function draftFromPrompt(
  sb: SupabaseClient,
  workspaceId: string,
  prompt: string,
  userContext: string,
): Promise<{ ok: true; draftIds: string[] } | { ok: false; reason: string }> {
  try {
    const draftIds = await runTurnToDraftIds(sb, workspaceId, {
      message:
        `Write one post in my voice. Topic direction: ${prompt}.\n\n` +
        `Use only this real context supplied by the user for personal facts, examples, outcomes, and beliefs:\n${userContext}\n\n` +
        "Do not invent a personal experience, client result, belief, or timeline beyond that context.",
    });
    return { ok: true, draftIds };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
