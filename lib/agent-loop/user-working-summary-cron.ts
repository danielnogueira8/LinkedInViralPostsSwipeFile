import { selectAllRows } from "@/lib/db-paginate";
import { supabaseAdmin } from "@/lib/supabase";
import { createWorkspaceLearningStore } from "@/lib/content-learning/workspace-learning";
import { redactHighConfidenceLeaks } from "@/lib/agent/output-guard";
import { getUserWorkingSummary } from "./user-working-summary";

const CRON_STATE_WORKSPACE_ID = "__system__:user-working-summary";
const CRON_CURSOR_KEY = "user_working_summary_cron_cursor_v1";
const CRON_BUDGET_MS = 300_000;
const CRON_MARGIN_MS = 60_000;

export function orderWorkspacesFromCursor(
  workspaces: string[],
  cursor: string | null,
): string[] {
  const ordered = [...new Set(workspaces)].sort();
  if (!cursor) return ordered;
  const index = ordered.indexOf(cursor);
  return index <= 0
    ? ordered
    : [...ordered.slice(index), ...ordered.slice(0, index)];
}

export async function listWorkspacesForWorkingSummary(): Promise<string[]> {
  const [voiceRows, publishedRows] = await Promise.all([
    selectAllRows<{ workspace_id: string }>(() =>
      supabaseAdmin()
        .from("voice_profiles")
        .select("workspace_id")
        .eq("status", "ready"),
    ),
    selectAllRows<{ workspace_id: string }>(() =>
      supabaseAdmin()
        .from("chat_artifacts")
        .select("workspace_id")
        .or("status.eq.posted,schedule_status.eq.published"),
    ),
  ]);
  return [
    ...new Set(
      [...voiceRows, ...publishedRows]
        .map((row) => row.workspace_id)
        .filter(Boolean),
    ),
  ].sort();
}

async function readCronCursor(): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from("settings")
    .select("value")
    .eq("workspace_id", CRON_STATE_WORKSPACE_ID)
    .eq("key", CRON_CURSOR_KEY)
    .maybeSingle();
  if (error || !data?.value || typeof data.value !== "object") return null;
  const cursor = (data.value as Record<string, unknown>).workspaceId;
  return typeof cursor === "string" && cursor ? cursor : null;
}

async function writeCronCursor(workspaceId: string): Promise<void> {
  const { error } = await supabaseAdmin().from("settings").upsert(
    {
      workspace_id: CRON_STATE_WORKSPACE_ID,
      key: CRON_CURSOR_KEY,
      value: { workspaceId },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id,key" },
  );
  if (error) throw error;
}

export async function runWorkingSummarySweep(input: {
  workspaces: string[];
  cursor: string | null;
  refresh: (workspaceId: string) => Promise<boolean>;
  saveCursor: (workspaceId: string) => Promise<void>;
  concurrency?: number;
  startedAt?: number;
  now?: () => number;
  budgetMs?: number;
  marginMs?: number;
}): Promise<{
  workspaces: number;
  processed: number;
  generated: number;
  skipped: number;
  failed: number;
  failures: Array<{ workspaceId: string; message: string }>;
  deadlineHit: boolean;
  nextCursor: string | null;
}> {
  const workspaces = orderWorkspacesFromCursor(
    input.workspaces,
    input.cursor,
  );
  const concurrency = input.concurrency ?? 3;
  const now = input.now ?? Date.now;
  const startedAt = input.startedAt ?? now();
  const budgetMs = input.budgetMs ?? CRON_BUDGET_MS;
  const marginMs = input.marginMs ?? CRON_MARGIN_MS;
  let processed = 0;
  let generated = 0;
  let skipped = 0;
  let failed = 0;
  const failures: Array<{ workspaceId: string; message: string }> = [];
  let deadlineHit = false;
  let nextCursor = workspaces[0] ?? null;

  for (let index = 0; index < workspaces.length; index += concurrency) {
    if (now() - startedAt > budgetMs - marginMs) {
      deadlineHit = true;
      nextCursor = workspaces[index];
      await input.saveCursor(nextCursor);
      break;
    }
    const batch = workspaces.slice(index, index + concurrency);
    const results = await Promise.allSettled(batch.map(input.refresh));
    processed += batch.length;
    for (const [resultIndex, result] of results.entries()) {
      if (result.status === "rejected") {
        failed += 1;
        const raw =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
        failures.push({
          workspaceId: batch[resultIndex]!,
          message: redactHighConfidenceLeaks(raw).text.slice(0, 240),
        });
      } else if (result.value) generated += 1;
      else skipped += 1;
    }
    nextCursor = workspaces[(index + batch.length) % workspaces.length] ?? null;
    if (nextCursor) await input.saveCursor(nextCursor);
  }
  return {
    workspaces: workspaces.length,
    processed,
    generated,
    skipped,
    failed,
    failures,
    deadlineHit,
    nextCursor,
  };
}

/**
 * The scheduler runs daily so a deadline-limited sweep can resume tomorrow,
 * while getUserWorkingSummary's seven-day TTL keeps the analysis itself weekly.
 */
export async function runWeeklyUserWorkingSummaries(opts: {
  concurrency?: number;
  startedAt?: number;
  signal?: AbortSignal;
} = {}) {
  const [workspaces, cursor] = await Promise.all([
    listWorkspacesForWorkingSummary(),
    readCronCursor(),
  ]);
  return runWorkingSummarySweep({
    workspaces,
    cursor,
    concurrency: opts.concurrency,
    startedAt: opts.startedAt,
    refresh: async (workspaceId) => {
      const db = supabaseAdmin();
      let learningFailure: unknown = null;
      const learning = await createWorkspaceLearningStore(
        db,
        (operation, error) => {
          if (operation === "refresh") learningFailure = error;
        },
      ).refresh(
        workspaceId,
        { mode: "active" },
      );
      if (learningFailure) {
        throw learningFailure instanceof Error
          ? learningFailure
          : new Error("Workspace Learning refresh failed");
      }
      const summary = await getUserWorkingSummary(db, workspaceId, {
        signal: opts.signal,
      });
      return Boolean(learning || summary);
    },
    saveCursor: writeCronCursor,
  });
}
