import type {
  LearningSignal,
  LearningSignalKind,
  WorkspaceLearningModel,
} from "@/lib/content-learning/contracts";
import { wrapUntrustedXml } from "@/lib/agent/untrusted";
import { z } from "zod";

export const WORKSPACE_LEARNING_DISPLAY_KINDS = [
  "topic",
  "format",
  "hook",
] as const satisfies readonly LearningSignalKind[];

export type WorkspaceLearningDisplayKind =
  (typeof WORKSPACE_LEARNING_DISPLAY_KINDS)[number];

const workspaceLearningSignalViewSchema = z
  .object({
    label: z.string().trim().min(1).max(240),
    score: z.number().min(-1).max(1),
    confidence: z.number().min(0).max(1),
    sampleSize: z.number().int().positive(),
    trend: z.enum(["up", "flat", "down", "unknown"]),
    example: z.string().trim().min(1).max(2_000).nullable(),
    performanceEvidenceCount: z.number().int().nonnegative(),
    outcomeEvidenceCount: z.number().int().nonnegative(),
  })
  .strict();
export type WorkspaceLearningSignalView = z.infer<
  typeof workspaceLearningSignalViewSchema
>;

const workspaceLearningCategoryViewSchema = z
  .object({
    kind: z.enum(WORKSPACE_LEARNING_DISPLAY_KINDS),
    signals: z.array(workspaceLearningSignalViewSchema).max(3),
  })
  .strict();
export type WorkspaceLearningCategoryView = z.infer<
  typeof workspaceLearningCategoryViewSchema
>;

export const workspaceLearningSummaryViewSchema = z
  .object({
    sourceMode: z.enum(["voice_exemplars", "published_posts"]),
    publishedPostCount: z.number().int().nonnegative(),
    analyzedPostCount: z.number().int().nonnegative(),
    voiceSourcePostCount: z.number().int().nonnegative().nullable(),
    calculatedAt: z.string().datetime({ offset: true }),
    categories: z.array(workspaceLearningCategoryViewSchema).length(3),
  })
  .strict();
export type WorkspaceLearningSummaryView = z.infer<
  typeof workspaceLearningSummaryViewSchema
>;

export function coerceWorkspaceLearningSummaryView(
  value: unknown,
): WorkspaceLearningSummaryView | null {
  const parsed = workspaceLearningSummaryViewSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rankSignals(signals: LearningSignal[]): LearningSignal[] {
  return [...signals].sort(
    (left, right) =>
      right.score - left.score ||
      right.confidence - left.confidence ||
      right.sampleSize - left.sampleSize ||
      compareText(left.label, right.label),
  );
}

function signalView(signal: LearningSignal): WorkspaceLearningSignalView {
  return {
    label: signal.label,
    score: signal.score,
    confidence: signal.confidence,
    sampleSize: signal.sampleSize,
    trend: signal.trend,
    example: signal.representativeExample,
    performanceEvidenceCount: signal.evidence.filter(
      (evidence) => evidence.kind === "performance",
    ).length,
    outcomeEvidenceCount: signal.evidence.filter(
      (evidence) => evidence.kind === "outcome",
    ).length,
  };
}

function displaySignals(
  model: WorkspaceLearningModel,
  kind: WorkspaceLearningDisplayKind,
): LearningSignal[] {
  const ranked = rankSignals(
    model.signals.filter((signal) => signal.kind === kind),
  );
  if (model.sourceMode === "voice_exemplars") return ranked.slice(0, 3);
  const positive = ranked.filter((signal) => signal.score > 0);
  return (positive.length > 0 ? positive : ranked.slice(0, 1)).slice(0, 3);
}

export function presentWorkspaceLearning(
  model: WorkspaceLearningModel,
): WorkspaceLearningSummaryView {
  const publishedArtifacts = new Set<string>();
  for (const signal of model.signals) {
    for (const evidence of signal.evidence) {
      if (evidence.kind === "publication") {
        publishedArtifacts.add(evidence.draftId);
      }
    }
  }
  const voiceSourcePostCount =
    model.sourceMode === "voice_exemplars"
      ? Math.max(0, ...model.signals.map((signal) => signal.sampleSize))
      : null;
  return {
    sourceMode: model.sourceMode,
    publishedPostCount: model.publishedPostCount,
    analyzedPostCount:
      model.sourceMode === "voice_exemplars"
        ? voiceSourcePostCount ?? 0
        : publishedArtifacts.size,
    voiceSourcePostCount,
    calculatedAt: model.calculatedAt,
    categories: WORKSPACE_LEARNING_DISPLAY_KINDS.map((kind) => ({
      kind,
      signals: displaySignals(model, kind).map(signalView),
    })),
  };
}

function measuredSignalLabel(signal: LearningSignal): string {
  if (signal.score >= 0.25) return "strong positive signal";
  if (signal.score > 0) return "positive signal";
  if (signal.score <= -0.25) return "underperforming signal";
  return "no clear lift yet";
}

export const WORKSPACE_LEARNING_PROMPT_CHARS_MAX = 1_800;

export function renderWorkspaceLearningBlock(
  model: WorkspaceLearningModel,
): string {
  if (model.status !== "active") return "";
  const header =
    model.sourceMode === "voice_exemplars"
      ? "Workspace Learning baseline from the user's Voice exemplars. These are observed writing patterns, NOT performance claims."
      : `Workspace Learning from ${model.publishedPostCount} published posts, linked to available performance, revision, and business-outcome evidence.`;
  const lines = [
    header,
    "Use these as soft guidance only. The current brief, explicit user direction, factual grounding, and approved preferences win.",
    "Do not copy an example's wording or invent a fact, result, story, or performance claim from it.",
  ];
  const promptKinds: LearningSignalKind[] = [
    "topic",
    "format",
    "hook",
    "cta",
    "source_pattern",
  ];
  const ranked = promptKinds.flatMap((kind) =>
    rankSignals(
      model.signals.filter((signal) => signal.kind === kind),
    ).slice(0, 2),
  );
  for (const signal of ranked) {
    if (
      model.sourceMode === "published_posts" &&
      signal.score <= 0
    ) {
      continue;
    }
    const evidenceLabel =
      model.sourceMode === "voice_exemplars"
        ? `Voice pattern across ${signal.sampleSize} source posts`
        : `${measuredSignalLabel(signal)} across ${signal.sampleSize} published posts`;
    const example = signal.representativeExample
      ? ` Example: "${signal.representativeExample}"`
      : "";
    const line = `- ${signal.kind}: ${signal.label} — ${evidenceLabel}.${example}`;
    if (
      lines.join("\n").length + line.length + 1 >
      WORKSPACE_LEARNING_PROMPT_CHARS_MAX
    ) {
      break;
    }
    lines.push(line);
  }
  if (lines.length === 3) return "";
  return [
    "WORKSPACE LEARNING (advisory evidence):",
    wrapUntrustedXml(
      "workspace-learning-evidence",
      lines.join("\n"),
    ),
  ].join("\n");
}
