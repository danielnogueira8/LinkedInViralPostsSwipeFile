// ---------------------------------------------------------------------------
// Weekly content batch — the "agent does work while you're away" pipeline.
//
// One trigger (an on-demand button in v1) produces a batch of review-ready
// drafts on the user's board: it finds this week's highest-signal posts from the
// latest scrape, adapts each into the user's own voice, and inserts them as
// `chat_artifacts` the user can edit/schedule/post. No live chat, no agent loop
// — each draft is one headless completeChat() call wrapped in the same voice +
// preferences + anti-slop guards the chat agent uses, PLUS deterministic nets
// (em-dash strip, length validation, truncation retry) because a headless call
// has NONE of the agent loop's render-time protections.
//
// Everything here is workspace-scoped by the CALLER (the route runs through the
// user's Clerk org via scopedSupabase), so writes carry the real workspace_id.
// The functions take workspaceId explicitly so they're testable + reusable by a
// future cron (which would pass it in and add explicit .eq scoping on writes).
// ---------------------------------------------------------------------------

import { supabaseAdmin } from "@/lib/supabase";
import {
  completeChat,
  logOpenRouterUsage,
  CHAT_MODEL,
  type ChatMessage,
  type Usage,
} from "@/lib/openrouter";
import { runTool } from "@/lib/agent/tools";
import { stripEmDashes, normalizePostBody } from "@/lib/agent/run";
import { deriveDraftTitle } from "@/lib/draft-title";
import {
  SKILLS,
  renderSkills,
  GLOBAL_WRITING_SKILL,
  POST_STRUCTURE_SKILL,
  type Skill,
} from "@/lib/agent/skills";
import { renderPreferencesBlock } from "@/lib/preferences";
import type { VoiceProfile } from "@/lib/claude";

// How many drafts a batch produces, and how many of those are sourced from a
// lead-magnet post (adapted with the user's lead_magnet_style when present).
// Small + fixed so the run is cheap to cost-bound and won't clutter the board
// (which loads 200 drafts, no pagination — see the drafts page).
export const BATCH_DRAFT_COUNT = 5;
export const BATCH_LEAD_MAGNET_COUNT = 1;

// A batch may run at most once per this window per workspace — the cost + board-
// clutter guard. Derived from the most recent batch draft's timestamp (no extra
// table needed for v1). Mirrors the voice-regen cooldown pattern.
export const BATCH_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

// Max body length we accept from a generated draft. Matches the drafts API cap
// (POST /api/drafts allows up to 20k) but we target real LinkedIn length; a body
// far past this is a runaway generation, so we reject + retry once.
const MAX_DRAFT_BODY = 3200;
// A body this short isn't a real post (the model bailed / returned a fragment).
const MIN_DRAFT_BODY = 120;
// Tokens for one post generation. A LinkedIn post is well under this; the
// headroom absorbs the model thinking before it writes.
const DRAFT_MAX_TOKENS = 2048;

// The `meta` provenance a batch draft carries, so the next run can dedup against
// already-adapted sources and the UI can show where a draft came from.
export type BatchDraftMeta = {
  source: "weekly_batch";
  batch_id: string;
  source_post_id: string | null;
  source_url: string | null;
  is_lead_magnet: boolean;
  generated_at: string;
};

// A single source post as getTopFromBatch returns it (the fields we use).
type SourcePost = {
  id: string;
  text: string;
  post_url: string | null;
  reactions: number | null;
  post_type: string | null;
};

// ---------------------------------------------------------------------------
// Cooldown — is this workspace allowed to run a batch right now?
// True (allowed) when there is NO weekly_batch draft newer than the cooldown.
// Pure-ish: one workspace-scoped read. Returns the unlock time when blocked.
// ---------------------------------------------------------------------------
export async function batchCooldown(
  workspaceId: string,
  nowMs: number,
): Promise<{ allowed: true } | { allowed: false; retryAtIso: string }> {
  const { data } = await supabaseAdmin()
    .from("chat_artifacts")
    .select("created_at")
    .eq("workspace_id", workspaceId)
    .eq("meta->>source", "weekly_batch")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const last = data?.created_at as string | undefined;
  if (!last) return { allowed: true };
  const unlockMs = new Date(last).getTime() + BATCH_COOLDOWN_MS;
  if (nowMs >= unlockMs) return { allowed: true };
  return { allowed: false, retryAtIso: new Date(unlockMs).toISOString() };
}

// ---------------------------------------------------------------------------
// Source selection — the freshest, highest-signal posts to adapt, EXCLUDING
// anything a prior batch already adapted (dedup via meta->>'source_post_id').
// Reserves BATCH_LEAD_MAGNET_COUNT slots for lead-magnet-typed sources when any
// exist. Reuses getTopFromBatch (the same 7-day "what's working" query the chat
// agent + board tools use), widening to 30 days on a sparse week.
// ---------------------------------------------------------------------------
export async function selectSourcePosts(
  workspaceId: string,
): Promise<{ regular: SourcePost[]; leadMagnet: SourcePost[] }> {
  const alreadyAdapted = await adaptedSourceIds(workspaceId);

  const pull = async (
    postType: "regular" | "lead_magnet" | undefined,
    want: number,
  ): Promise<SourcePost[]> => {
    if (want <= 0) return [];
    // Over-fetch so we still have enough after removing already-adapted posts.
    const args: Record<string, unknown> = { limit: Math.max(want * 3, 10) };
    if (postType) args.post_type = postType;
    let res = await runTool("get_top_from_batch", args, workspaceId);
    // Sparse week → widen the window once (same nudge the tool gives the agent).
    if ((res as { sparse?: boolean }).sparse) {
      res = await runTool(
        "get_top_from_batch",
        { ...args, window_days: 30 },
        workspaceId,
      );
    }
    const posts = ((res as { posts?: SourcePost[] }).posts ?? []).filter(
      (p) => p && p.id && !alreadyAdapted.has(p.id) && (p.text ?? "").trim(),
    );
    return posts.slice(0, want);
  };

  const leadMagnet = await pull("lead_magnet", BATCH_LEAD_MAGNET_COUNT);
  // Fill the rest with regular posts, excluding any lead-magnet ids we just took.
  const takenLm = new Set(leadMagnet.map((p) => p.id));
  const regularWanted = BATCH_DRAFT_COUNT - leadMagnet.length;
  const regular = (await pull("regular", regularWanted)).filter(
    (p) => !takenLm.has(p.id),
  );
  return { regular, leadMagnet };
}

// The set of source_post_ids this workspace's prior batches already adapted, so
// a new run never re-adapts the same post. Reads the provenance we write into
// each batch draft's meta.
export async function adaptedSourceIds(
  workspaceId: string,
): Promise<Set<string>> {
  const { data } = await supabaseAdmin()
    .from("chat_artifacts")
    .select("meta")
    .eq("workspace_id", workspaceId)
    .eq("meta->>source", "weekly_batch")
    .limit(500);
  const ids = new Set<string>();
  for (const row of data ?? []) {
    const id = (row as { meta?: { source_post_id?: string | null } }).meta
      ?.source_post_id;
    if (id) ids.add(id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Prompt assembly — the system context for a headless draft, mirroring what the
// chat agent injects: the always-on writing rules + structure rules, the right
// task skill (voice-match, or lead-magnet for a lead-magnet source), the user's
// voice profile, and their durable preferences. Pure + exported for tests.
// ---------------------------------------------------------------------------
export function buildDraftSystem(opts: {
  voice: VoiceProfile | null;
  preferences: ReadonlyArray<{ rule: string }>;
  isLeadMagnet: boolean;
}): string {
  const taskSkillId = opts.isLeadMagnet ? "lead-magnet" : "voice-match";
  const taskSkill = SKILLS.find((s: Skill) => s.id === taskSkillId);
  const skillBlock = renderSkills(
    taskSkill ? [taskSkill] : [],
  );
  const prefBlock = renderPreferencesBlock(opts.preferences);
  const voiceBlock = opts.voice
    ? `The user's VOICE PROFILE (write EXACTLY in this voice — study the exemplars):\n${JSON.stringify(
        // For a lead magnet, surface lead_magnet_style; otherwise it's noise.
        opts.isLeadMagnet
          ? opts.voice
          : { ...opts.voice, lead_magnet_style: undefined },
        null,
        2,
      )}`
    : "The user has no saved voice profile yet — write in a clear, credible, human founder voice.";

  return [
    "You are drafting ONE publish-ready LinkedIn post for the user, adapting the STRUCTURE and ANGLE of a high-performing post from their niche into the USER'S OWN voice and expertise. Do NOT copy the source post's specifics — borrow only its shape (hook pattern, rhythm, format) and make the substance the user's.",
    GLOBAL_WRITING_SKILL,
    POST_STRUCTURE_SKILL,
    skillBlock,
    voiceBlock,
    prefBlock,
    "Return ONLY the post body — no preamble, no 'Here's your post', no commentary, no surrounding quotes. Just the post text ready to publish.",
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
}

// The user-turn instruction: the source post to adapt.
function buildDraftUser(source: SourcePost, isLeadMagnet: boolean): string {
  const kind = isLeadMagnet ? "lead-magnet (giveaway/CTA) post" : "post";
  return [
    `Here is a high-performing ${kind} from the user's niche. Adapt its structure and angle into a fresh ${kind} in the user's voice, about the user's own expertise:`,
    "",
    '"""',
    source.text.slice(0, 4000),
    '"""',
    "",
    "Write the user's version now.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Generate one draft body from a source post: headless completeChat + the
// deterministic nets a headless call needs (em-dash strip, paragraph normalize,
// length validation, ONE truncation/short retry). Returns the clean body, or
// null when the model couldn't produce a usable post after the retry (the batch
// just skips that source rather than persisting junk).
// ---------------------------------------------------------------------------
export async function generateDraftBody(opts: {
  source: SourcePost;
  system: string;
  isLeadMagnet: boolean;
  signal?: AbortSignal;
}): Promise<{ body: string | null; usage: Usage | undefined }> {
  const messages: ChatMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: buildDraftUser(opts.source, opts.isLeadMagnet) },
  ];

  // Accumulate token usage across BOTH attempts so the caller charges the cost
  // cap for every call we actually made — even when we ultimately reject the
  // output (a rejected draft still cost money). Returns body:null on failure.
  let usage: Usage | undefined;
  const addUsage = (u: Usage | undefined) => {
    if (!u) return;
    usage = {
      prompt_tokens: (usage?.prompt_tokens ?? 0) + (u.prompt_tokens ?? 0),
      completion_tokens:
        (usage?.completion_tokens ?? 0) + (u.completion_tokens ?? 0),
    };
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await completeChat({
        messages,
        model: CHAT_MODEL,
        maxTokens: DRAFT_MAX_TOKENS,
        signal: opts.signal,
      });
    } catch {
      return { body: null, usage }; // transport error — skip this source
    }
    addUsage(res.usage);
    // Deterministic anti-slop + shape nets (the agent loop's render path does
    // these; a headless call must do them itself).
    const cleaned = normalizePostBody(stripEmDashes(res.text.trim()));
    const truncated = res.finishReason === "length";
    if (
      !truncated &&
      cleaned.length >= MIN_DRAFT_BODY &&
      cleaned.length <= MAX_DRAFT_BODY
    ) {
      return { body: cleaned, usage };
    }
    // Retry once with a corrective nudge; a second failure → skip this source.
    if (attempt === 0) {
      messages.push(
        { role: "assistant", content: res.text.slice(0, 2000) },
        {
          role: "user",
          content: truncated
            ? "That got cut off. Write the COMPLETE post, tighter, so it fits — one publish-ready LinkedIn post, body only."
            : `That wasn't a usable post (${cleaned.length} chars). Write ONE complete, publish-ready LinkedIn post in the user's voice — body only, no preamble.`,
        },
      );
    }
  }
  return { body: null, usage };
}

// ---------------------------------------------------------------------------
// Insert a generated draft onto the board — mirrors POST /api/drafts exactly
// (chat_artifacts row, chat_id null, kind 'post', deriveDraftTitle), plus the
// batch provenance in meta. Workspace-scoped write (explicit workspace_id).
// ---------------------------------------------------------------------------
export async function insertBatchDraft(opts: {
  workspaceId: string;
  body: string;
  meta: BatchDraftMeta;
}): Promise<{ id: string; title: string; body: string } | null> {
  const title = deriveDraftTitle(opts.body);
  const { data, error } = await supabaseAdmin()
    .from("chat_artifacts")
    .insert({
      workspace_id: opts.workspaceId,
      chat_id: null,
      kind: "post",
      // A batch draft is a full post → the 'drafting' column, matching
      // defaultDraftStatus('post') so the board treats it like any new draft.
      status: "drafting",
      title,
      body: opts.body,
      meta: opts.meta,
    })
    .select("id, title, body")
    .single();
  if (error) return null;
  return data as { id: string; title: string; body: string };
}

// ---------------------------------------------------------------------------
// runWeeklyBatch — the orchestrator. Reads voice + preferences, selects fresh
// un-adapted sources, generates each draft in voice (with all nets), inserts the
// good ones onto the board, and returns a summary. Does NOT check the cooldown
// or cost cap — the route does that BEFORE calling this (fail-closed), so this
// function is the pure pipeline (and reusable by a future cron).
//
// Best-effort per draft: a source that fails generation is skipped, not fatal —
// a partial batch (3 of 5) still delivers value. Returns the created drafts +
// how many sources were attempted, so the caller can message honestly ("added 3
// drafts" / "nothing to adapt this week").
// ---------------------------------------------------------------------------
export type WeeklyBatchResult = {
  batchId: string;
  drafts: Array<{ id: string; title: string; body: string }>;
  attempted: number;
  reason?: "no_sources";
};

export async function runWeeklyBatch(opts: {
  workspaceId: string;
  batchId: string;
  nowIso: string;
  signal?: AbortSignal;
}): Promise<WeeklyBatchResult> {
  const { workspaceId, batchId, nowIso } = opts;

  // Voice + durable preferences, read once and reused for every draft.
  const [voice, preferences] = await Promise.all([
    readVoiceProfile(workspaceId),
    readPreferences(workspaceId),
  ]);

  const { regular, leadMagnet } = await selectSourcePosts(workspaceId);
  const sources: Array<{ post: SourcePost; isLeadMagnet: boolean }> = [
    ...leadMagnet.map((post) => ({ post, isLeadMagnet: true })),
    ...regular.map((post) => ({ post, isLeadMagnet: false })),
  ];
  if (sources.length === 0) {
    return { batchId, drafts: [], attempted: 0, reason: "no_sources" };
  }

  const drafts: Array<{ id: string; title: string; body: string }> = [];
  for (const { post, isLeadMagnet } of sources) {
    const system = buildDraftSystem({ voice, preferences, isLeadMagnet });
    const generated = await generateDraftBody({
      source: post,
      system,
      isLeadMagnet,
      signal: opts.signal,
    });
    // Log spend against the monthly cost cap, tagged so it's attributable to the
    // batch (separate line in usage summaries). Awaited so the cap can't be
    // under-counted. Logged whether or not the draft ends up inserted — the
    // model call cost real money regardless.
    await logOpenRouterUsage(
      "weekly_batch_draft",
      CHAT_MODEL,
      generated.usage,
      workspaceId,
      { batch_id: batchId, source_post_id: post.id ?? null },
    );
    if (!generated.body) continue; // model couldn't adapt this source cleanly
    const meta: BatchDraftMeta = {
      source: "weekly_batch",
      batch_id: batchId,
      source_post_id: post.id ?? null,
      source_url: post.post_url ?? null,
      is_lead_magnet: isLeadMagnet,
      generated_at: nowIso,
    };
    const inserted = await insertBatchDraft({
      workspaceId,
      body: generated.body,
      meta,
    });
    if (inserted) drafts.push(inserted);
  }

  return { batchId, drafts, attempted: sources.length };
}

// Read the workspace's voice profile jsonb (null when none / not ready).
async function readVoiceProfile(
  workspaceId: string,
): Promise<VoiceProfile | null> {
  const { data } = await supabaseAdmin()
    .from("voice_profiles")
    .select("profile, status")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!data || data.status !== "ready") return null;
  return (data.profile as VoiceProfile) ?? null;
}

// Read the workspace's durable preferences (newest first, capped).
async function readPreferences(
  workspaceId: string,
): Promise<Array<{ rule: string }>> {
  const { data } = await supabaseAdmin()
    .from("content_preferences")
    .select("rule")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(20);
  return (data ?? []) as Array<{ rule: string }>;
}
