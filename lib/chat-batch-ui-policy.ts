import type { Artifact } from "@/lib/agent/contracts";
import type { Message } from "@/lib/chat-hydration";

type BatchRunSnapshot = {
  id?: string | null;
  status?: string;
  stage?: string | null;
  total?: number;
  attempted?: number;
  created?: number;
  error?: string | null;
};

export const BATCH_CHAT_TITLE_PREFIX = "Weekly batch —";

// The client's "is this a weekly-batch draft?" classifier. Batch drafts carry
// meta.source === 'weekly_batch' (stamped by the pipeline in lib/batch/weekly.ts);
// nothing else does. This is what gates the inline Approve / Reject buttons on
// draft cards inside the batch chat (PR: batch review moves to Cowork).
// Exported for unit tests.
export function isWeeklyBatchArtifact(a: Artifact): boolean {
  return (a.meta as { source?: unknown } | undefined)?.source === "weekly_batch";
}

function batchIdForWeeklyBatchArtifact(a: Artifact): string | null {
  if (!isWeeklyBatchArtifact(a)) return null;
  const raw = (a.meta as { batch_id?: unknown } | undefined)?.batch_id;
  return typeof raw === "string" && raw.trim() ? raw : null;
}

function isWeeklyBatchMessage(m: Message): boolean {
  return (
    m.artifacts?.some(isWeeklyBatchArtifact) ||
    /building your week|Found \d+ posts? to adapt|Review them on your Posts page/i.test(
      m.text,
    )
  );
}

export function shouldShowBatchStatusForChat({
  title,
  messages,
  artifacts,
  run,
}: {
  title: string | null | undefined;
  messages: Message[];
  artifacts: Artifact[];
  run: BatchRunSnapshot | null;
}): boolean {
  if (!run) return false;
  const status = run.status;
  const visibleStatus =
    status === "pending" ||
    status === "running" ||
    status === "done" ||
    status === "failed";
  if (!visibleStatus) return false;

  const titleLooksLikeBatch = !!title?.startsWith(BATCH_CHAT_TITLE_PREFIX);
  const hasWeeklyBatchContent =
    messages.some(isWeeklyBatchMessage) || artifacts.some(isWeeklyBatchArtifact);
  if (!titleLooksLikeBatch && !hasWeeklyBatchContent) return false;

  if (status === "pending" || status === "running") {
    return true;
  }

  const runId = typeof run.id === "string" && run.id.trim() ? run.id : null;
  if (!runId) return false;
  return artifacts.some((artifact) => batchIdForWeeklyBatchArtifact(artifact) === runId);
}
