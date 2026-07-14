import { supabaseAdmin } from "@/lib/supabase";
import { completeChat, logOpenRouterUsage } from "@/lib/openrouter";
import { selectAllRows } from "@/lib/db-paginate";

// The weekly pattern-mining brief (viral-learning loop, PR 4). Once a week we
// sample a workspace's VIRAL vs NON-VIRAL scraped posts and ask a strong model
// to distill what STRUCTURALLY separates them — the hooks, length bands,
// openers, CTA styles, and cadence that are working NOW — into a short,
// editable brief. The brief is stored in the `settings` KV and injected into
// the writer prompt, so the writer's guidance auto-updates from real outcomes
// instead of being hand-maintained.
//
// This is the one reasoning-heavy job in the loop, so it runs on Sonnet (via
// OpenRouter). It runs weekly per workspace, so absolute cost is trivial.

// Sonnet via OpenRouter — the analytical job. Env-overridable for pinning/A-B.
export const PATTERN_MODEL =
  process.env.OPENROUTER_PATTERN_MODEL || "anthropic/claude-sonnet-5";

// The settings KV key the brief lives under (per workspace).
export const PATTERN_BRIEF_KEY = "viral_pattern_brief";

// Sampling bounds. Enough signal to find patterns, few enough to stay cheap and
// inside the model's window. A workspace under the floor is skipped (too little
// signal for a meaningful brief).
const SAMPLE_PER_CLASS = 20;
const MIN_VIRAL_FLOOR = 5;
const POST_CHARS = 700;
const BRIEF_MAX_TOKENS = 900;
// Per-workspace Sonnet-call deadline. The cron runs under a 300s function
// ceiling across ALL workspaces; a single stall must not consume the budget.
const PATTERN_TIMEOUT_MS = 60_000;

export type PatternBrief = {
  brief: string;
  generatedAt: string; // ISO
  sampleViral: number;
  sampleMediocre: number;
};

const PATTERN_SYSTEM = [
  "You are a LinkedIn content strategist. You will see two sets of posts from ONE creator's niche: posts that went VIRAL (beat their creator's own baseline) and posts that UNDERPERFORMED.",
  "Your job: identify what STRUCTURALLY separates the two — not the topics, and never the specific stories, claims, or wording. Look only at reusable mechanics: hook patterns, opening-line types, post length, paragraph rhythm, formatting (lists/line breaks), rhetorical moves, and CTA style.",
  "Output a SHORT, punchy brief (a handful of bullet points, no preamble) titled with what is working NOW. Each bullet is an actionable instruction a writer can apply to a NEW post on a DIFFERENT topic. Do not reference any specific post. Do not invent statistics.",
].join("\n\n");

// Pull a sample of a workspace's viral and non-viral scraped posts. Scoped to
// the accounts the workspace tracks (posts is global, so we must filter by the
// tracked account set). Returns trimmed bodies for both classes.
async function samplePosts(
  workspaceId: string,
): Promise<{ viral: string[]; mediocre: string[] }> {
  const sb = supabaseAdmin();
  const { data: links, error: linkErr } = await sb
    .from("workspace_accounts")
    .select("account_id")
    .eq("workspace_id", workspaceId);
  if (linkErr) throw linkErr;
  const accountIds = (links ?? []).map((r) => r.account_id as string);
  if (accountIds.length === 0) return { viral: [], mediocre: [] };

  async function load(isViral: boolean): Promise<string[]> {
    const { data, error } = await sb
      .from("posts")
      .select("text")
      .in("account_id", accountIds)
      .eq("is_viral", isViral)
      .not("text", "is", null)
      .order("scraped_at", { ascending: false })
      .limit(SAMPLE_PER_CLASS);
    if (error) throw error;
    return (data ?? [])
      .map((r) => (typeof r.text === "string" ? r.text.trim() : ""))
      .filter(Boolean)
      .map((t) => (t.length > POST_CHARS ? `${t.slice(0, POST_CHARS)}…` : t));
  }

  const [viral, mediocre] = await Promise.all([load(true), load(false)]);
  return { viral, mediocre };
}

// Generate (and persist) the pattern brief for one workspace. Returns the brief,
// or null when there's too little signal (skipped) or the model call failed.
// Never throws — a weekly cron over many workspaces must not abort on one.
export async function generatePatternBrief(
  workspaceId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<PatternBrief | null> {
  let sample: { viral: string[]; mediocre: string[] };
  try {
    sample = await samplePosts(workspaceId);
  } catch (e) {
    console.warn(`pattern-brief sample failed for ${workspaceId}: ${(e as Error).message}`);
    return null;
  }
  if (sample.viral.length < MIN_VIRAL_FLOOR) {
    // Not enough viral signal yet — leave any existing brief untouched.
    return null;
  }

  const user = [
    "VIRAL posts (beat the creator's own norm):",
    ...sample.viral.map((t, i) => `${i + 1}. """${t}"""`),
    "",
    "UNDERPERFORMED posts:",
    ...(sample.mediocre.length
      ? sample.mediocre.map((t, i) => `${i + 1}. """${t}"""`)
      : ["(none available)"]),
    "",
    "Write the brief now.",
  ].join("\n");

  let res;
  try {
    res = await completeChat({
      messages: [
        { role: "system", content: PATTERN_SYSTEM },
        { role: "user", content: user },
      ],
      model: PATTERN_MODEL,
      maxTokens: BRIEF_MAX_TOKENS,
      signal: opts.signal,
      // Per-call deadline so ONE stalled Sonnet call can't eat the weekly cron's
      // maxDuration budget and get the whole run killed mid-fan-out.
      timeoutMs: PATTERN_TIMEOUT_MS,
    });
  } catch (e) {
    console.warn(`pattern-brief model call failed for ${workspaceId}: ${(e as Error).message}`);
    return null;
  }
  // Best-effort cost log — logOpenRouterUsage THROWS on a DB insert failure, and
  // this call sits after the try/catch above. In a Promise.all fan-out (the
  // weekly cron) an unhandled throw here would reject the whole slice and drop
  // the other workspaces' briefs — violating this module's "never throws on one
  // workspace" contract. So swallow it (the brief itself already succeeded).
  await logOpenRouterUsage("pattern_brief", PATTERN_MODEL, res.usage, workspaceId, {
    sample_viral: sample.viral.length,
    sample_mediocre: sample.mediocre.length,
  }).catch((e) => {
    console.warn(`pattern-brief usage-log failed for ${workspaceId}: ${(e as Error).message}`);
  });

  const brief = res.text.trim();
  if (!brief) return null;

  const record: PatternBrief = {
    brief,
    // Stamped by the caller-provided clock via the DB (updated_at); we store the
    // ISO here from a fresh Date — this runs in a cron, not a resumable script.
    generatedAt: new Date().toISOString(),
    sampleViral: sample.viral.length,
    sampleMediocre: sample.mediocre.length,
  };
  await storePatternBrief(workspaceId, record);
  return record;
}

export async function storePatternBrief(
  workspaceId: string,
  brief: PatternBrief,
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("settings")
    .upsert(
      {
        workspace_id: workspaceId,
        key: PATTERN_BRIEF_KEY,
        value: brief,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,key" },
    );
  if (error) throw error;
}

export async function getPatternBrief(
  workspaceId: string,
): Promise<PatternBrief | null> {
  const { data, error } = await supabaseAdmin()
    .from("settings")
    .select("value")
    .eq("workspace_id", workspaceId)
    .eq("key", PATTERN_BRIEF_KEY)
    .maybeSingle();
  if (error || !data) return null;
  const value = data.value as Partial<PatternBrief> | null;
  if (!value || typeof value.brief !== "string" || !value.brief.trim()) return null;
  return {
    brief: value.brief,
    generatedAt: typeof value.generatedAt === "string" ? value.generatedAt : "",
    sampleViral: typeof value.sampleViral === "number" ? value.sampleViral : 0,
    sampleMediocre: typeof value.sampleMediocre === "number" ? value.sampleMediocre : 0,
  };
}

// Wrap the brief for injection into the writer's system prompt. Empty string
// when there's no brief (keeps the cache prefix intact — see weekly-draft-prompt).
export function renderPatternBriefBlock(brief: PatternBrief | null): string {
  if (!brief?.brief.trim()) return "";
  return [
    "WHAT'S WORKING NOW in this niche (auto-learned from recent viral vs. underperforming posts — apply the structure, invent your own substance):",
    brief.brief.trim(),
  ].join("\n");
}

// Every workspace that tracks at least one account — the set the weekly cron
// generates briefs for. Distinct workspace_ids from workspace_accounts.
export async function listWorkspacesWithTrackedAccounts(): Promise<string[]> {
  // Paginated: (workspace × account) link rows exceed 1000 at scale, and a bare
  // select would silently cap there — the weekly cron would skip every
  // workspace past the first page.
  const rows = await selectAllRows<{ workspace_id: string }>(() =>
    supabaseAdmin().from("workspace_accounts").select("workspace_id"),
  );
  return [...new Set(rows.map((r) => r.workspace_id))];
}

// The weekly cron body: regenerate the pattern brief for every workspace with
// tracked accounts, bounded-concurrency. Per-workspace failures are swallowed
// by generatePatternBrief (returns null), so one bad workspace never aborts the
// run. Returns a summary for the cron log.
export async function runWeeklyPatternBriefs(
  opts: { concurrency?: number; signal?: AbortSignal } = {},
): Promise<{ workspaces: number; generated: number; skipped: number }> {
  const workspaces = await listWorkspacesWithTrackedAccounts();
  const concurrency = opts.concurrency ?? 4;
  let generated = 0;
  let skipped = 0;

  for (let i = 0; i < workspaces.length; i += concurrency) {
    const slice = workspaces.slice(i, i + concurrency);
    const results = await Promise.all(
      slice.map((ws) => generatePatternBrief(ws, { signal: opts.signal })),
    );
    for (const r of results) {
      if (r) generated += 1;
      else skipped += 1;
    }
  }
  return { workspaces: workspaces.length, generated, skipped };
}
