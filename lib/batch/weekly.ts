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

import { revalidatePath } from "next/cache";
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
//
// BATCH_DRAFT_COUNT lives in the client-safe lib/batch/client so the UI can read
// the SAME number (card count + preview slots) without importing this server
// module. Re-exported here so server callers keep importing it from one place.
export { BATCH_DRAFT_COUNT } from "@/lib/batch/client";
import { BATCH_DRAFT_COUNT } from "@/lib/batch/client";
export const BATCH_LEAD_MAGNET_COUNT = 2;

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
// In-flight guard — is a batch ALREADY running for this workspace right now?
//
// Batches are unlimited (gated only by the monthly credit cap); the ONE thing we
// still prevent is two overlapping runs from a rapid double-click / double-fire,
// which would double-spend and clutter the board with two concurrent sets. This
// is NOT a cooldown: it clears the moment the running batch settles. A run stuck
// pending/running past the stale window doesn't count (it died), so a genuine
// retry is never blocked. One workspace-scoped read.
// ---------------------------------------------------------------------------
export async function batchInFlight(
  workspaceId: string,
  nowMs: number,
): Promise<boolean> {
  const { data } = await supabaseAdmin()
    .from("batch_runs")
    .select("status, updated_at")
    .eq("workspace_id", workspaceId)
    .in("status", ["pending", "running"])
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = data as { status?: string; updated_at?: string } | null;
  if (!row?.updated_at) return false;
  // A pending/running row that hasn't updated within the stale window is a dead
  // run (its after() was killed) — not actually in flight.
  const ageMs = nowMs - new Date(row.updated_at).getTime();
  return ageMs <= BATCH_RUN_STALE_MS;
}

// The wide window the batch BACK-FILLS from when the fresh 7-day pool can't
// supply a full batch. getTopFromBatch's own sparse-widen only fires below 3
// results, so at 4-5 fresh posts it never triggered — the batch silently
// settled short of BATCH_DRAFT_COUNT ("consistently 4 of 6"). We widen from the
// BATCH side whenever we're under target, not just when near-empty.
const BATCH_BACKFILL_WINDOW_DAYS = 30;

// ---------------------------------------------------------------------------
// Source selection — the freshest, highest-signal posts to adapt, EXCLUDING
// anything a prior batch adapted recently (dedup via meta->>'source_post_id',
// bounded by ADAPTED_HORIZON_DAYS). Reserves BATCH_LEAD_MAGNET_COUNT slots for
// lead-magnet-typed sources when any exist. Targets BATCH_DRAFT_COUNT total; if
// the 7-day pool comes up short, BACK-FILLS from a 30-day window before giving
// up, so a quiet week still yields as many as the wider pool allows.
// ---------------------------------------------------------------------------
export async function selectSourcePosts(
  workspaceId: string,
): Promise<{ regular: SourcePost[]; leadMagnet: SourcePost[] }> {
  const alreadyAdapted = await adaptedSourceIds(workspaceId);

  // Pull up to `want` fresh, un-adapted posts of a type, from `windowDays`.
  // `excludeIds` are ids already chosen this run (so back-fill can't duplicate).
  const pull = async (
    postType: "regular" | "lead_magnet" | undefined,
    want: number,
    windowDays: number,
    excludeIds: Set<string>,
  ): Promise<SourcePost[]> => {
    if (want <= 0) return [];
    // Over-fetch generously so dedup doesn't starve us. Bounded by the tool's
    // own hard cap (20); want*4 gives more depth to filter through.
    const args: Record<string, unknown> = {
      limit: Math.max(want * 4, 12),
      window_days: windowDays,
    };
    if (postType) args.post_type = postType;
    const res = await runTool("get_top_from_batch", args, workspaceId);
    const posts = ((res as { posts?: SourcePost[] }).posts ?? []).filter(
      (p) =>
        p &&
        p.id &&
        !alreadyAdapted.has(p.id) &&
        !excludeIds.has(p.id) &&
        (p.text ?? "").trim(),
    );
    return posts.slice(0, want);
  };

  const chosen = new Set<string>();
  const take = (posts: SourcePost[]) => {
    for (const p of posts) if (p.id) chosen.add(p.id);
    return posts;
  };

  // 1) Lead-magnet slot(s), fresh 7-day window first, then 30-day back-fill.
  let leadMagnet = take(
    await pull("lead_magnet", BATCH_LEAD_MAGNET_COUNT, 7, chosen),
  );
  if (leadMagnet.length < BATCH_LEAD_MAGNET_COUNT) {
    leadMagnet = [
      ...leadMagnet,
      ...take(
        await pull(
          "lead_magnet",
          BATCH_LEAD_MAGNET_COUNT - leadMagnet.length,
          BATCH_BACKFILL_WINDOW_DAYS,
          chosen,
        ),
      ),
    ];
  }

  // 2) Regular posts fill the rest to BATCH_DRAFT_COUNT — 7-day first, then a
  //    30-day back-fill for whatever the fresh week couldn't supply. This is the
  //    core fix: we widen whenever we're UNDER TARGET, not only when near-empty.
  const regularWanted = BATCH_DRAFT_COUNT - leadMagnet.length;
  let regular = take(await pull("regular", regularWanted, 7, chosen));
  if (regular.length < regularWanted) {
    regular = [
      ...regular,
      ...take(
        await pull(
          "regular",
          regularWanted - regular.length,
          BATCH_BACKFILL_WINDOW_DAYS,
          chosen,
        ),
      ),
    ];
  }

  // Diagnostic: one structured line so a run's supply funnel is inspectable
  // (grep `batch_supply`). If total < BATCH_DRAFT_COUNT here, it's genuine
  // source scarcity — the writers never had a full set to work with.
  console.log(
    JSON.stringify({
      batch_supply: {
        workspace_id: workspaceId,
        target: BATCH_DRAFT_COUNT,
        lead_magnet: leadMagnet.length,
        regular: regular.length,
        total: leadMagnet.length + regular.length,
        adapted_excluded: alreadyAdapted.size,
      },
    }),
  );

  return { regular, leadMagnet };
}

// ---------------------------------------------------------------------------
// getBatchReadiness — the "should the home card show a live count / cooldown?"
// snapshot. Called ONCE on the chat-home mount (NOT the 2.5s run-poll), so it's
// allowed to do the real source selection. Returns how many fresh posts are
// ready to adapt (capped at the batch size). Reuses selectSourcePosts (dedup +
// windowing) so the card's count can't disagree with what a real run produces.
//
// Batches are UNLIMITED (gated only by the monthly credit cap), so there's no
// 7-day cooldown anymore. `cooldown` is kept as a permanently-off field purely
// for client back-compat (older card code reads cooldown.onCooldown).
// ---------------------------------------------------------------------------
export type BatchReadiness = {
  // How many fresh, un-adapted sources are available this week (0..BATCH_DRAFT_COUNT).
  available: number;
  cooldown: { onCooldown: false };
};

export async function getBatchReadiness(
  workspaceId: string,
): Promise<BatchReadiness> {
  const { regular, leadMagnet } = await selectSourcePosts(workspaceId);
  return {
    available: regular.length + leadMagnet.length,
    cooldown: { onCooldown: false },
  };
}

// How long a source post stays "already adapted" and thus excluded from a new
// batch. RECENCY-BOUNDED (not forever): a post adapted more than this long ago
// becomes eligible again — fair for a fresh audience/angle, and it stops the
// eligible pool from monotonically draining to zero over a long-running
// workspace (the "consistently 4 of 6" bug: forever-dedup starved the source
// count). 56 days = 8 weeks.
export const ADAPTED_HORIZON_DAYS = 56;

// The set of source_post_ids this workspace's prior batches adapted WITHIN the
// recency horizon, so a new run doesn't re-adapt a recently-used post but CAN
// reuse an old one. Reads the provenance we write into each batch draft's meta.
export async function adaptedSourceIds(
  workspaceId: string,
): Promise<Set<string>> {
  const sinceIso = new Date(
    Date.now() - ADAPTED_HORIZON_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { data } = await supabaseAdmin()
    .from("chat_artifacts")
    .select("meta")
    .eq("workspace_id", workspaceId)
    .eq("meta->>source", "weekly_batch")
    // Only recently-adapted posts count against the pool (see ADAPTED_HORIZON).
    .gte("created_at", sinceIso)
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
  // When the batch runs AS a Cowork chat session, the draft belongs to that
  // chat so it renders inline in the transcript (a companion chat_messages row
  // carries it as an artifact). Omitted for a headless run → chat_id stays null.
  chatId?: string | null;
}): Promise<{ id: string; title: string; body: string } | null> {
  const title = deriveDraftTitle(opts.body);
  const { data, error } = await supabaseAdmin()
    .from("chat_artifacts")
    .insert({
      workspace_id: opts.workspaceId,
      chat_id: opts.chatId ?? null,
      // Auto-classify the KIND from the source post's type — the batch already
      // knows (meta.is_lead_magnet, set from the source's post_type). No detector
      // needed here; the signal is authoritative.
      kind: opts.meta.is_lead_magnet ? "lead_magnet" : "post",
      // REVIEW GATE: a batch draft lands in 'pending_review', NOT on the board.
      // The user validates the whole batch in the review panel; approving flips
      // it to 'drafting'. 'pending_review' is off-board (the board's grouping
      // ignores any status outside its 4 columns), so nothing appears unvetted.
      status: "pending_review",
      title,
      body: opts.body,
      meta: opts.meta,
    })
    .select("id, title, body")
    .single();
  if (error) {
    // Surface WHY the insert failed instead of swallowing it — the failure
    // otherwise shows only as a generic "Couldn't save this draft" lane and is
    // undebuggable. The classic cause is an unrun migration: a new kind
    // ('lead_magnet', migration 055) or status ('pending_review', migration 056)
    // rejected by a stale check constraint (Postgres error 23514). Grep
    // `batch_insert_fail`. Keep the batch going (return null → the lane is
    // marked failed); one bad insert must not abort the run.
    console.log(
      JSON.stringify({
        batch_insert_fail: {
          workspace_id: opts.workspaceId,
          batch_id: opts.meta.batch_id,
          kind: opts.meta.is_lead_magnet ? "lead_magnet" : "post",
          code: error.code ?? null,
          message: error.message,
        },
      }),
    );
    return null;
  }
  // Invalidate the Posts page RSC segment on EVERY successful batch insert,
  // not only at settle. Without this, a user clicking "Review this batch" mid-
  // run saw the pre-batch snapshot; the drafts that had already landed weren't
  // visible until the batch finished and the route's own revalidatePath fired.
  // Same swallow-throw contract as the /api/saved-posts helper (PR #523):
  // never surface a cache-invalidation glitch to the caller — if the RSC layer
  // is unhappy, the batch itself keeps running and the closing revalidatePath
  // will still fire.
  try {
    revalidatePath("/dashboard/posts");
  } catch {
    /* never let a cache blip break the run */
  }
  return data as { id: string; title: string; body: string };
}

// ---------------------------------------------------------------------------
// Batch-as-chat: companion chat_messages. When the batch runs as a Cowork
// session, each step writes an assistant message so the chat renders it as a
// normal transcript on reload (no live SSE needed — persist-as-you-go). Best-
// effort: a failed message write never breaks the run (the drafts are the real
// output; the transcript is presentation). Same insert shape the stream route
// uses (role/content/tool_calls/artifacts).
// ---------------------------------------------------------------------------

// The artifact shape persisted into chat_messages.artifacts (matches the chat's
// Artifact type). A batch draft is 'lead_magnet' on the board, but the chat
// artifact enum is post|hook|cite — so we persist kind:'post' and carry the
// lead-magnet signal in meta (the UI already reads meta.is_lead_magnet).
type ChatArtifact = {
  id: string;
  kind: "post" | "hook";
  title: string;
  body: string;
  meta: Record<string, unknown>;
};

// Create the Cowork chat that hosts a batch run + its opening assistant message,
// so navigating in immediately shows a live-looking session (not an empty chat).
// Returns the chat id, or null on failure (the batch then runs headless — the
// route falls back to chat_id null, byte-identical to the old behavior).
export async function createBatchChat(
  workspaceId: string,
  title: string,
): Promise<string | null> {
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("chats")
      .insert({ workspace_id: workspaceId, title })
      .select("id")
      .single();
    if (error || !data) return null;
    const chatId = (data as { id: string }).id;
    await writeBatchChatMessage(
      workspaceId,
      chatId,
      "On it — building your week. I'll pull this week's top posts and draft each one in your voice. They'll appear below as I finish them.",
    );
    return chatId;
  } catch {
    return null;
  }
}

// Insert one assistant message into a chat. Best-effort; returns nothing.
async function writeBatchChatMessage(
  workspaceId: string,
  chatId: string,
  content: string,
  artifacts?: ChatArtifact[],
): Promise<void> {
  try {
    await supabaseAdmin().from("chat_messages").insert({
      chat_id: chatId,
      workspace_id: workspaceId,
      role: "assistant",
      content,
      artifacts: artifacts && artifacts.length ? artifacts : null,
    });
  } catch {
    /* transcript is presentation — a dropped message never breaks the batch */
  }
}

// ---------------------------------------------------------------------------
// Batch run state (batch_runs table) — the LIVE PROGRESS surface the client
// polls. The pipeline writes one row and bumps it as it works, so the UI can
// show step-by-step feedback ("Finding posts" → "Drafting 3 of 5" → "Done")
// instead of a blind spinner. All workspace-scoped writes.
// ---------------------------------------------------------------------------

export type BatchRunStatus = "pending" | "running" | "done" | "failed";

export type BatchRun = {
  id: string;
  workspace_id: string;
  status: BatchRunStatus;
  stage: string | null;
  total: number;
  attempted: number;
  created: number;
  error: string | null;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
};

const BATCH_RUN_COLS =
  "id, workspace_id, status, stage, total, attempted, created, error, started_at, updated_at, finished_at";

// A run is considered STALE (died mid-flight — the after() task was killed) if
// it's been pending/running longer than this without an update. The status
// endpoint flips such a row to 'failed' so the UI stops spinning forever.
export const BATCH_RUN_STALE_MS = 5 * 60 * 1000;

// Create the run row up front (status 'pending'), returning its id. The client
// gets this id immediately and starts polling.
// `id` is passed in so the run row's id IS the batchId — one identifier for both
// the run rollup (batch_runs) and the per-worker slots + artifact provenance
// (batch_draft_slots.batch_id, chat_artifacts.meta.batch_id). This lets the poll
// (which reads the run row) hand the client the batchId it needs to fetch slots,
// with no extra column and no correlation table.
export async function createBatchRun(
  workspaceId: string,
  id: string,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from("batch_runs")
    .insert({
      id,
      workspace_id: workspaceId,
      status: "pending",
      stage: "Getting started",
    })
    .select("id")
    .single();
  if (error) return null;
  return (data as { id: string }).id;
}

// Patch the run row — the pipeline calls this to publish progress. Always
// bumps updated_at (so the stale check is accurate) and is workspace-scoped.
export async function updateBatchRun(
  runId: string,
  workspaceId: string,
  patch: Partial<
    Pick<
      BatchRun,
      "status" | "stage" | "total" | "attempted" | "created" | "error"
    >
  > & { finished?: boolean },
): Promise<void> {
  const { finished, ...fields } = patch;
  const row: Record<string, unknown> = {
    ...fields,
    updated_at: new Date().toISOString(),
  };
  if (finished) row.finished_at = new Date().toISOString();
  try {
    await supabaseAdmin()
      .from("batch_runs")
      .update(row)
      .eq("id", runId)
      .eq("workspace_id", workspaceId);
  } catch {
    // Progress is best-effort — a failed status write must never break the run.
  }
}

// Read the workspace's latest run (the poll target). Recovers a stale run
// (after() died) by flipping it to 'failed' so the client stops spinning.
export async function latestBatchRun(
  workspaceId: string,
  nowMs: number,
): Promise<BatchRun | null> {
  const { data } = await supabaseAdmin()
    .from("batch_runs")
    .select(BATCH_RUN_COLS)
    .eq("workspace_id", workspaceId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const run = (data as BatchRun) ?? null;
  if (!run) return null;
  if (run.status === "pending" || run.status === "running") {
    const ageMs = nowMs - new Date(run.updated_at).getTime();
    if (ageMs > BATCH_RUN_STALE_MS) {
      await updateBatchRun(run.id, workspaceId, {
        status: "failed",
        stage: "Timed out",
        error: "This batch stopped unexpectedly. Please try again.",
        finished: true,
      });
      return {
        ...run,
        status: "failed",
        stage: "Timed out",
        error: "This batch stopped unexpectedly. Please try again.",
      };
    }
  }
  return run;
}

// ---------------------------------------------------------------------------
// Batch draft slots (batch_draft_slots) — one row per parallel WORKER. The board
// UI renders one live lane per slot: the source it grabbed, the skill it's
// applying, and its status (queued → drafting → filed/skipped/failed). Created
// up front so the user sees WHAT is being adapted before any draft exists.
// ---------------------------------------------------------------------------

export type BatchSlotStatus =
  | "queued"
  | "drafting"
  | "filed"
  | "skipped"
  | "failed";

export type BatchDraftSlot = {
  id: string;
  workspace_id: string;
  batch_id: string;
  slot_index: number;
  source_post_id: string | null;
  source_first_line: string | null;
  source_url: string | null;
  post_type: string | null;
  is_lead_magnet: boolean;
  skill_label: string | null;
  status: BatchSlotStatus;
  artifact_id: string | null;
  draft_title: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

const SLOT_COLS =
  "id, workspace_id, batch_id, slot_index, source_post_id, source_first_line, source_url, post_type, is_lead_magnet, skill_label, status, artifact_id, draft_title, error, created_at, updated_at";

// First non-empty line of a source post, clamped — the lane's "what's being
// adapted" subtitle. Pure + exported for tests.
export function firstLine(text: string | null | undefined, max = 90): string {
  const line = (text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

// Create all the slot rows up front (status 'queued'), one per source, so the
// board can render every lane with its source the instant a batch starts.
// Best-effort: a failure here just means no live lanes (the run still works).
async function createBatchSlots(
  workspaceId: string,
  batchId: string,
  sources: Array<{ post: SourcePost; isLeadMagnet: boolean }>,
): Promise<void> {
  const rows = sources.map((s, i) => ({
    workspace_id: workspaceId,
    batch_id: batchId,
    slot_index: i,
    source_post_id: s.post.id ?? null,
    source_first_line: firstLine(s.post.text),
    source_url: s.post.post_url ?? null,
    post_type: s.post.post_type ?? null,
    is_lead_magnet: s.isLeadMagnet,
    skill_label: s.isLeadMagnet ? "Lead-magnet voice" : "Your voice",
    status: "queued" as const,
  }));
  try {
    await supabaseAdmin().from("batch_draft_slots").insert(rows);
  } catch {
    /* no lanes — the run still proceeds */
  }
}

// Patch one slot by (batch_id, slot_index), workspace-scoped. Best-effort.
async function updateBatchSlot(
  workspaceId: string,
  batchId: string,
  slotIndex: number,
  patch: Partial<
    Pick<
      BatchDraftSlot,
      "status" | "artifact_id" | "draft_title" | "error"
    >
  >,
): Promise<void> {
  try {
    await supabaseAdmin()
      .from("batch_draft_slots")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("workspace_id", workspaceId)
      .eq("batch_id", batchId)
      .eq("slot_index", slotIndex);
  } catch {
    /* progress is best-effort */
  }
}

// Read a run's slots in order (the board poll target). Workspace-scoped.
export async function batchSlots(
  workspaceId: string,
  batchId: string,
): Promise<BatchDraftSlot[]> {
  const { data } = await supabaseAdmin()
    .from("batch_draft_slots")
    .select(SLOT_COLS)
    .eq("workspace_id", workspaceId)
    .eq("batch_id", batchId)
    .order("slot_index", { ascending: true });
  return (data ?? []) as BatchDraftSlot[];
}

// ---------------------------------------------------------------------------
// runWeeklyBatch — the orchestrator. Reads voice + preferences, selects fresh
// un-adapted sources, then adapts them into the user's voice as a TEAM OF
// PARALLEL WORKERS (concurrent, bounded to the source count ≤ BATCH_DRAFT_COUNT),
// each updating its own slot row so the board can show live lanes. Does NOT check
// the cooldown or cost cap — the route does that BEFORE calling this (fail-
// closed), so this function is the pure pipeline (and reusable by a future cron).
//
// Publishes run-level progress via the optional `runId` (batch_runs rollup) AND
// per-worker progress via the slot rows. When runId is omitted (tests / a cron
// that doesn't need the UI), the run-level writes no-op; slot writes still record
// per-worker state (harmless, and lets a cron's board resume).
//
// Best-effort per worker: a source that fails generation is skipped, not fatal —
// a partial batch still delivers value. Returns the created drafts + how many
// sources were attempted, so the caller can message honestly.
// ---------------------------------------------------------------------------
export type WeeklyBatchResult = {
  batchId: string;
  drafts: Array<{ id: string; title: string; body: string }>;
  attempted: number;
  // How many attempted sources the model couldn't adapt cleanly (attempted −
  // created). Surfaced so the caller/UI can explain a partial batch.
  skipped?: number;
  reason?: "no_sources";
};

export async function runWeeklyBatch(opts: {
  workspaceId: string;
  batchId: string;
  nowIso: string;
  runId?: string;
  // When set, the batch runs AS a Cowork chat session: each filed draft belongs
  // to this chat and gets a companion assistant message, so the transcript shows
  // the drafts streaming in. Omitted → headless (chat_id null), byte-identical
  // to the old behavior (safe for a cron path).
  chatId?: string;
  signal?: AbortSignal;
}): Promise<WeeklyBatchResult> {
  const { workspaceId, batchId, nowIso, runId, chatId } = opts;

  // Publish a progress update to the run row when we have one (no-op otherwise).
  const progress = (
    patch: Parameters<typeof updateBatchRun>[2],
  ): Promise<void> =>
    runId ? updateBatchRun(runId, workspaceId, patch) : Promise.resolve();

  await progress({ status: "running", stage: "Finding this week's top posts" });

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
    await progress({
      status: "done",
      stage: "No fresh posts to adapt this week",
      total: 0,
      finished: true,
    });
    if (chatId) {
      await writeBatchChatMessage(
        workspaceId,
        chatId,
        "I couldn't find any fresh posts to adapt this week. Try again after your next scrape.",
      );
    }
    return { batchId, drafts: [], attempted: 0, reason: "no_sources" };
  }

  // Create the worker lanes up front so the board shows every source instantly.
  await createBatchSlots(workspaceId, batchId, sources);
  await progress({
    stage: `Dispatched ${sources.length} writer${sources.length === 1 ? "" : "s"}`,
    total: sources.length,
    attempted: sources.length,
  });

  // Each worker adapts ONE source, updating its own slot lane as it goes. The
  // shared `created` counter (bumped as drafts land) keeps the batch_runs rollup
  // live for surfaces that only read the run row.
  const drafts: Array<{ id: string; title: string; body: string }> = [];
  let createdCount = 0;
  const worker = async (
    { post, isLeadMagnet }: { post: SourcePost; isLeadMagnet: boolean },
    slotIndex: number,
  ): Promise<void> => {
    await updateBatchSlot(workspaceId, batchId, slotIndex, {
      status: "drafting",
    });
    const system = buildDraftSystem({ voice, preferences, isLeadMagnet });
    const generated = await generateDraftBody({
      source: post,
      system,
      isLeadMagnet,
      signal: opts.signal,
    });
    // Log spend (whether or not the draft is usable — the call cost money).
    await logOpenRouterUsage(
      "weekly_batch_draft",
      CHAT_MODEL,
      generated.usage,
      workspaceId,
      { batch_id: batchId, source_post_id: post.id ?? null },
    );
    if (!generated.body) {
      // The model couldn't produce a usable post — mark the lane skipped so the
      // gap is honest, not invisible.
      await updateBatchSlot(workspaceId, batchId, slotIndex, {
        status: "skipped",
        error: "Couldn't adapt this one cleanly.",
      });
      return;
    }
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
      chatId,
    });
    if (inserted) {
      drafts.push(inserted);
      createdCount++;
      await updateBatchSlot(workspaceId, batchId, slotIndex, {
        status: "filed",
        artifact_id: inserted.id,
        draft_title: inserted.title,
      });
      // Batch-as-chat: drop this draft into the transcript as its own assistant
      // message the moment its worker finishes — so cards appear one by one.
      if (chatId) {
        await writeBatchChatMessage(workspaceId, chatId, "", [
          {
            id: inserted.id,
            kind: "post", // chat artifact enum; lead-magnet signal rides in meta
            title: inserted.title,
            body: inserted.body,
            meta: { ...meta },
          },
        ]);
      }
      // Bump the run rollup so counter-only surfaces stay live.
      await progress({ created: createdCount });
    } else {
      await updateBatchSlot(workspaceId, batchId, slotIndex, {
        status: "failed",
        error: "Couldn't save this draft.",
      });
    }
  };

  // Fan out: all workers run concurrently. Bounded by the source count, which is
  // itself capped at BATCH_DRAFT_COUNT — so at most that many concurrent GLM
  // calls. A worker never throws (all failure paths mark the slot), so this
  // Promise.all can't reject and abort its siblings.
  await Promise.all(sources.map((s, i) => worker(s, i)));

  // Settle the run with an HONEST final stage: report the shortfall when fewer
  // drafts landed than sources attempted, so the user knows why they got N of M
  // instead of silently wondering. The gap = sources the model couldn't adapt
  // cleanly (their lanes are already marked 'skipped'/'failed' individually).
  const n = drafts.length;
  const missed = sources.length - n;
  await progress({
    status: "done",
    stage: settleStage(n, missed),
    created: n,
    finished: true,
  });

  // Batch-as-chat: the closing message that owns the review handoff.
  if (chatId) {
    const closing =
      n === 0
        ? "I couldn't draft anything usable from this week's posts. Try again after your next scrape."
        : `${settleStage(n, missed)}. Review them on your Posts page to approve the ones you want.`;
    await writeBatchChatMessage(workspaceId, chatId, closing);
  }

  return { batchId, drafts, attempted: sources.length, skipped: missed };
}

// The final stage message, honest about a partial batch. Pure + exported.
export function settleStage(created: number, missed: number): string {
  if (created === 0) {
    return missed > 0
      ? "Couldn't adapt any of this week's posts — try again after your next scrape"
      : "Couldn't draft anything usable this week";
  }
  // Drafts land in the review gate now, not straight on the board.
  const ready = `${created} draft${created === 1 ? "" : "s"} ready to review`;
  if (missed <= 0) return ready;
  return `${ready} · ${missed} couldn't be adapted this time`;
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
