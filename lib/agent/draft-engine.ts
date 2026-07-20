import type { ContentFeedback } from "@/lib/content-feedback";
import type { ContentPreference } from "@/lib/preferences";
import type { RecentDraft } from "@/lib/recent-drafts";
import type { ChatMessage } from "@/lib/openrouter";
import type { AgentEvent, Artifact } from "@/lib/agent/contracts";
import {
  runWriterTurn,
  type GroundedSource,
  type Source,
  type WriterDependencies,
  type WriterInput,
  type WriterTask,
} from "@/lib/agent/execute/writer";
import type {
  DraftCandidateTransform,
  DraftFinalizerDecision,
  DraftFinalizerSpecialists,
} from "@/lib/agent/finalize/finalizer";
import type { DirectPartialTextSpec } from "@/lib/agent/direct-deliverable-policy";
import type { DirectRefineFocus } from "@/lib/agent/direct-refine-policy";

import type { CoworkTurnTelemetry } from "@/lib/agent/cowork-telemetry";
import type { NoModelFormat } from "@/lib/agent/no-model-formats";
import type { ToolResult } from "@/lib/agent/tools";

export const DIRECT_DRAFT_ENGINE_DEADLINE_MS = 60_000;
export const THIN_DRAFT_ENGINE_DEADLINE_MS = 120_000;
export const NARROW_REFINE_DEADLINE_MS = 45_000;
export const MULTI_DRAFT_DEADLINE_MS = 240_000;
export const GROUNDED_EVIDENCE_TEXT_BUDGET_CHARS = 72_000;

type PreferenceInput = Pick<ContentPreference, "rule">;
type FeedbackInput = Pick<
  ContentFeedback,
  "rating" | "reasons" | "note" | "body_snapshot"
>;

export type DraftEngineSource = Source;
export type DraftEngineGroundedSource = GroundedSource;

export type DraftEngineTask =
  | { kind: "original"; variation?: never }
  | { kind: "source"; source: DraftEngineSource; variation?: never }
  | { kind: "partial"; spec: DirectPartialTextSpec; source?: DraftEngineSource }
  | {
      kind: "multi";
      expectedCount: number;
      source?: DraftEngineSource;
      groundedSources?: DraftEngineGroundedSource[];
    }
  | { kind: "grounded"; sources: DraftEngineGroundedSource[]; variation?: never }
  | {
      kind: "refine";
      instruction: string;
      focus: DirectRefineFocus;
      target: Artifact & { kind: "post" };
    };

export type DraftEngineInput = {
  workspaceId: string;
  sessionId?: string;
  userInstruction: string;
  history?: ChatMessage[];
  task?: DraftEngineTask;
  voiceResult: ToolResult;
  preferences: PreferenceInput[];
  feedbackMemory: FeedbackInput[];
  priorPostDrafts: RecentDraft[];
  format?: NoModelFormat | null;
  customSkillBodies?: string[];
  customSkillNames?: string[];
  leadMagnetBlock?: string;
  creatorStyleBlock?: string;
  signal?: AbortSignal;
  cancellationProbe?: (signal: AbortSignal) => Promise<boolean>;
  finalizerSpecialists?: Partial<DraftFinalizerSpecialists>;
  transformCandidate?: DraftCandidateTransform;
  finalTransformCandidate?: DraftCandidateTransform;
  onFinalizerDecision?: (decision: DraftFinalizerDecision) => void;
  onModelUsed?: (model: string) => void;
  telemetry?: CoworkTurnTelemetry;
  lean?: boolean;
  enableStructureGate?: boolean;
  finalizationProfile?: "modeled_batch";
};

export type DraftEngineDependencies = WriterDependencies;

function toWriterTask(task: DraftEngineTask | undefined): WriterTask | undefined {
  if (!task) return undefined;
  switch (task.kind) {
    case "original":
      return { kind: "original" };
    case "source":
      return { kind: "source", source: task.source };
    case "grounded":
      return { kind: "grounded", sources: task.sources };
    case "partial":
      return {
        kind: "partial",
        spec: task.spec,
        ...(task.source ? { source: task.source } : {}),
      };
    case "multi":
      return {
        kind: "multi",
        expectedCount: task.expectedCount,
        ...(task.source ? { source: task.source } : {}),
        ...(task.groundedSources
          ? { groundedSources: task.groundedSources }
          : {}),
      };
    case "refine":
      return {
        kind: "refine",
        instruction: task.instruction,
        focus: task.focus,
        target: task.target,
      };
    default:
      return undefined;
  }
}

function toWriterInput(
  input: DraftEngineInput,
  dependencies: Partial<DraftEngineDependencies>,
): WriterInput {
  const { finalizationProfile: _, ...rest } = input;
  void _;
  return {
    ...rest,
    task: toWriterTask(input.task),
    dependencies,
  };
}

export async function* runDraftEngine(
  input: DraftEngineInput,
  dependencies: Partial<DraftEngineDependencies> = {},
): AsyncGenerator<AgentEvent> {
  yield* runWriterTurn(toWriterInput(input, dependencies));
}
