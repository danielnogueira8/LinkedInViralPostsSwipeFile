import type { AgentEvent } from "@/lib/agent/contracts";
import type { DraftEngineInput } from "@/lib/agent/draft-engine";
import {
  runModeledDraftSlot as runModeledDraftSlotInner,
  type ModeledDraftSlotInput,
  type ModeledDraftSlotOutcome,
} from "@/lib/agent/execute/writer";

export type ModeledDraftSlotRunner = (
  input: DraftEngineInput,
) => AsyncGenerator<AgentEvent>;

export type {
  CanonicalWorkspaceModelingSource,
  ModeledDraftBatchContext,
  ModeledDraftSlotIdentity,
  ModeledDraftSlotInput,
  ModeledDraftSlotOutcome,
  ModeledDraftSlotProtocolErrorCode,
  ModeledDraftSlotRejectionCode,
  MODELED_DRAFT_SLOT_PROTOCOL_ERROR_CODES,
  MODELED_DRAFT_SLOT_REJECTION_CODES,
} from "@/lib/agent/execute/writer";

export async function runModeledDraftSlot(
  input: ModeledDraftSlotInput,
  dependencies: Partial<{ runDraftEngine: ModeledDraftSlotRunner }> = {},
): Promise<ModeledDraftSlotOutcome> {
  if (dependencies.runDraftEngine) {
    return runModeledDraftSlotInner(input, {
      runDraftEngine: dependencies.runDraftEngine as (
        input: import("@/lib/agent/execute/writer").WriterInput,
      ) => AsyncGenerator<AgentEvent>,
    });
  }
  return runModeledDraftSlotInner(input);
}
