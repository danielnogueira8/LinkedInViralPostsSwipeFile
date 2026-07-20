export {
  artifactMatchesModeledDraftSlotContract,
  executeModeledDraftBatch,
  isCanonicalModeledSourceUrl,
  type AcquiredModeledDraftBatch,
  type ExecuteModeledDraftBatchInput,
  type ModeledDraftBatchAcquireResult,
  type ModeledDraftBatchDependencies,
  type ModeledDraftBatchIncompleteReason,
  type ModeledDraftBatchReleaseReason,
  type ModeledDraftBatchRepository,
  type ModeledDraftBatchResult,
  type ModeledDraftBatchSource,
  type ModeledDraftSlotCheckpoint,
  type ModeledPostArtifact,
} from "@/lib/agent/execute/writer";

import { runModeledDraftSlot } from "@/lib/agent/execute/writer";

export const productionModeledDraftBatchDependencies = {
  runSlot: runModeledDraftSlot,
};
