import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sanitizeVoiceProfile } from "@/lib/claude";
import {
  CONTENT_LEARNING_SCHEMA_VERSION,
  workspaceLearningModelSchema,
  type ContentOutcomeKind,
  type ContentOutcomeSource,
  type LearningEvidence,
  type LearningSignal,
  type LearningSignalKind,
  type RefreshWorkspaceLearningOptions,
  type WorkspaceLearning,
  type WorkspaceLearningModel,
} from "@/lib/content-learning/contracts";

export const WORKSPACE_LEARNING_CALCULATION_VERSION =
  "workspace-learning-v2";
export const WORKSPACE_LEARNING_REFRESH_MS =
  7 * 24 * 60 * 60 * 1_000;
export const WORKSPACE_LEARNING_INELIGIBLE_CACHE_MS = 60_000;
const PUBLISHED_SAMPLE_LIMIT = 50;
const INELIGIBLE_CACHE_MAX_WORKSPACES = 500;

type IneligibleCacheEntry = {
  publishedPostCount: number;
  expiresAt: number;
};

const ineligibleWorkspaces = new Map<string, IneligibleCacheEntry>();

function cacheIneligibleWorkspace(
  workspaceId: string,
  publishedPostCount: number,
  now: number,
): void {
  ineligibleWorkspaces.delete(workspaceId);
  ineligibleWorkspaces.set(workspaceId, {
    publishedPostCount,
    expiresAt: now + WORKSPACE_LEARNING_INELIGIBLE_CACHE_MS,
  });
  while (
    ineligibleWorkspaces.size > INELIGIBLE_CACHE_MAX_WORKSPACES
  ) {
    const oldest = ineligibleWorkspaces.keys().next().value;
    if (typeof oldest !== "string") break;
    ineligibleWorkspaces.delete(oldest);
  }
}

function isRecentlyIneligible(
  workspaceId: string,
  publishedPostCount: number,
  now: number,
): boolean {
  const cached = ineligibleWorkspaces.get(workspaceId);
  if (
    !cached ||
    cached.expiresAt <= now ||
    cached.publishedPostCount !== publishedPostCount
  ) {
    ineligibleWorkspaces.delete(workspaceId);
    return false;
  }
  return true;
}

type LearningRow = {
  id: string;
  schema_version: number;
  workspace_id: string;
  version: number;
  status: WorkspaceLearningModel["status"];
  source_mode: WorkspaceLearningModel["sourceMode"];
  published_post_count: number;
  calculation_version: string;
  input_fingerprint: string;
  signals: unknown;
  calculated_at: string;
  created_at: string;
};

export type PublishedRow = {
  id: string;
  title: string | null;
  body: string;
  status: string;
  schedule_status: string | null;
  published_at: string | null;
  created_at: string;
  media_attachments: unknown;
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function selectRecentPublishedPosts(
  scheduled: PublishedRow[],
  posted: PublishedRow[],
): PublishedRow[] {
  const unique = new Map<string, PublishedRow>();
  for (const row of [...scheduled, ...posted]) unique.set(row.id, row);
  return [...unique.values()]
    .sort((left, right) => {
      const byDate =
        Date.parse(right.published_at ?? right.created_at) -
        Date.parse(left.published_at ?? left.created_at);
      return byDate || compareText(left.id, right.id);
    })
    .slice(0, PUBLISHED_SAMPLE_LIMIT);
}

type LineageRow = {
  id: string;
  artifact_id: string;
  origin: unknown;
  inputs: unknown;
  descriptor: unknown;
};

type AnalyticsRow = {
  artifact_id: string;
  impressions: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  fetched_at: string;
};

type RevisionRow = {
  id: string;
  saved_artifact_id: string | null;
  source_artifact_id: string;
};

type OutcomeRow = {
  id: string;
  draft_id: string;
  kind: ContentOutcomeKind;
  source: ContentOutcomeSource;
  confidence: number;
  quantity: number;
  amount_minor: number | null;
  currency: string | null;
};

type EvidenceRow = {
  artifact_id: string;
  analytics_id: string | null;
  impressions: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  analytics_fetched_at: string | null;
  revision_id: string | null;
  outcome_id: string | null;
  outcome_kind: ContentOutcomeKind | null;
  outcome_source: ContentOutcomeSource | null;
  outcome_confidence: number | null;
  outcome_quantity: number | null;
  outcome_amount_minor: number | null;
  outcome_currency: string | null;
};

type PublishedSample = {
  post: PublishedRow;
  lineage: LineageRow | null;
  analytics: AnalyticsRow | null;
  revisions: RevisionRow[];
  outcomes: OutcomeRow[];
  publishedAt: string | null;
  descriptors: Record<LearningSignalKind, string | null>;
};

type SignalMember = {
  sample: PublishedSample;
  key: string;
};

function learningFromRow(row: LearningRow): WorkspaceLearningModel | null {
  const parsed = workspaceLearningModelSchema.safeParse({
    schemaVersion: row.schema_version,
    id: row.id,
    workspaceId: row.workspace_id,
    version: row.version,
    status: row.status,
    sourceMode: row.source_mode,
    publishedPostCount: row.published_post_count,
    calculationVersion: row.calculation_version,
    inputFingerprint: row.input_fingerprint,
    signals: row.signals,
    calculatedAt: row.calculated_at,
    createdAt: row.created_at,
  });
  return parsed.success ? parsed.data : null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareText(left, right))
      .map(
        ([key, child]) =>
          `${JSON.stringify(key)}:${canonicalJson(child)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function workspaceLearningFingerprint(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex")}`;
}

function clean(value: unknown, max = 240): string | null {
  if (typeof value !== "string") return null;
  const result = value.replace(/\s+/g, " ").trim().slice(0, max).trim();
  return result || null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function opening(body: string): string {
  return (
    body
      .trim()
      .split(/\n\s*\n/, 1)[0]
      ?.replace(/\s+/g, " ")
      .trim()
      .slice(0, 180) ?? ""
  );
}

function classifyHook(body: string): string {
  const first = opening(body);
  if (/\?$/.test(first)) return "Question";
  if (/\b(?:stop|wrong|myth|don't|doesn't|not)\b/i.test(first)) {
    return "Contrarian claim";
  }
  if (/\d/.test(first)) return "Number-led";
  if (/^(?:I|My|We|Our)\b/i.test(first)) return "Personal story";
  return "Direct claim";
}

function classifyStructure(post: PublishedRow): string {
  const attachments = Array.isArray(post.media_attachments)
    ? post.media_attachments
    : [];
  if (attachments.length > 0) {
    const type = clean(record(attachments[0]).type, 40);
    return type ? `${type} post` : "Media post";
  }
  if (/^(?:\d+[.)]|[-•])\s/m.test(post.body)) return "List post";
  return "Text-only post";
}

function classifyCta(
  body: string,
  inputs: Record<string, unknown>,
): string {
  if (clean(inputs.leadMagnetId)) return "Lead magnet";
  const ending = body.trim().slice(-300);
  if (/\?[\s"'’”)]*$/.test(ending)) return "Conversation question";
  if (/\b(?:comment|dm|message me|download|link)\b/i.test(ending)) {
    return "Direct response";
  }
  return "No explicit CTA";
}

function publishedDescriptors(
  post: PublishedRow,
  lineage: LineageRow | null,
): Record<LearningSignalKind, string | null> {
  const descriptor = record(lineage?.descriptor);
  const origin = record(lineage?.origin);
  const inputs = record(lineage?.inputs);
  return {
    topic:
      clean(descriptor.topic) ??
      clean(post.title) ??
      clean(opening(post.body)),
    hook: clean(descriptor.hookType) ?? classifyHook(post.body),
    format:
      clean(descriptor.structure) ?? classifyStructure(post),
    cta: clean(descriptor.ctaType) ?? classifyCta(post.body, inputs),
    source_pattern: clean(origin.kind) ?? "unknown",
    voice_preference: null,
  };
}

function clamp(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

function average(values: number[]): number | null {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

const OUTCOME_KIND_WEIGHT: Record<ContentOutcomeKind, number> = {
  qualified_conversation: 1,
  qualified_dm: 1,
  lead_magnet_conversion: 1.25,
  lead: 1.5,
  booked_call: 3,
  pipeline: 5,
  revenue: 8,
};

export function outcomeEvidenceValue(outcome: OutcomeRow): number {
  const sourceWeight = outcome.source === "leadshark" ? 1 : 0.85;
  const amountMajor =
    outcome.amount_minor === null ? null : outcome.amount_minor / 100;
  const amountWeight =
    amountMajor === null
      ? 1
      : 1 + Math.min(2, Math.log10(1 + amountMajor) / 3);
  return (
    OUTCOME_KIND_WEIGHT[outcome.kind] *
    outcome.quantity *
    outcome.confidence *
    sourceWeight *
    amountWeight
  );
}

function sampleOutcomeValue(sample: PublishedSample): number {
  return sample.outcomes.reduce(
    (total, outcome) => total + outcomeEvidenceValue(outcome),
    0,
  );
}

function metricScore(
  group: PublishedSample[],
  all: PublishedSample[],
): { score: number; baseline: number | null; coverage: number } {
  const allImpressions = all.flatMap((sample) =>
    typeof sample.analytics?.impressions === "number"
      ? [sample.analytics.impressions]
      : [],
  );
  const groupImpressions = group.flatMap((sample) =>
    typeof sample.analytics?.impressions === "number"
      ? [sample.analytics.impressions]
      : [],
  );
  const baseline = average(allImpressions);
  const groupAverage = average(groupImpressions);
  const impressionScore =
    baseline !== null && groupAverage !== null
      ? clamp((groupAverage - baseline) / Math.max(1, baseline))
      : null;

  const allOutcomeAverage =
    average(all.map(sampleOutcomeValue)) ?? 0;
  const groupOutcomeAverage =
    average(group.map(sampleOutcomeValue)) ?? 0;
  const hasOutcomes = all.some((sample) => sample.outcomes.length > 0);
  const outcomeScore = hasOutcomes
    ? clamp(
        (groupOutcomeAverage - allOutcomeAverage) /
          Math.max(1, allOutcomeAverage),
      )
    : null;
  const components = [impressionScore, outcomeScore].filter(
    (value): value is number => value !== null,
  );
  return {
    score: components.length ? average(components)! : 0,
    baseline,
    coverage: groupImpressions.length / Math.max(1, group.length),
  };
}

function signalTrend(group: PublishedSample[]): LearningSignal["trend"] {
  const measured = [...group]
    .filter(
      (
        sample,
      ): sample is PublishedSample & {
        publishedAt: string;
        analytics: AnalyticsRow;
      } =>
        typeof sample.analytics?.impressions === "number" &&
        sample.publishedAt !== null,
    )
    .sort(
      (left, right) =>
        Date.parse(right.publishedAt) - Date.parse(left.publishedAt),
    );
  if (measured.length < 2) return "unknown";
  const split = Math.ceil(measured.length / 2);
  const recent = average(
    measured.slice(0, split).map((sample) => sample.analytics!.impressions!),
  )!;
  const prior = average(
    measured.slice(split).map((sample) => sample.analytics!.impressions!),
  );
  if (prior === null) return "unknown";
  const change = (recent - prior) / Math.max(1, prior);
  if (change > 0.1) return "up";
  if (change < -0.1) return "down";
  return "flat";
}

function evidenceForSample(sample: PublishedSample): LearningEvidence[] {
  const evidence: LearningEvidence[] = [];
  if (sample.lineage) {
    evidence.push({
      kind: "lineage",
      lineageId: sample.lineage.id,
      artifactId: sample.post.id,
    });
  }
  evidence.push({
    kind: "publication",
    draftId: sample.post.id,
    publishedAt: sample.publishedAt,
  });
  if (typeof sample.analytics?.impressions === "number") {
    evidence.push({
      kind: "performance",
      draftId: sample.post.id,
      metric: "impressions",
      value: sample.analytics.impressions,
      observedAt: sample.analytics.fetched_at,
    });
  }
  const revision = sample.revisions[0];
  if (revision) {
    evidence.push({
      kind: "revision",
      revisionEventId: revision.id,
      artifactId: sample.post.id,
    });
  }
  for (const outcome of sample.outcomes) {
    evidence.push({ kind: "outcome", outcomeId: outcome.id });
  }
  return evidence;
}

function boundedEvidence(
  samples: PublishedSample[],
): LearningEvidence[] {
  const all = samples.flatMap(evidenceForSample);
  const selected = new Set<number>();
  const kinds: LearningEvidence["kind"][] = [
    "lineage",
    "publication",
    "performance",
    "revision",
    "outcome",
  ];
  for (const kind of kinds) {
    const index = all.findIndex((item) => item.kind === kind);
    if (index >= 0) selected.add(index);
  }
  for (let index = 0; index < all.length && selected.size < 200; index += 1) {
    selected.add(index);
  }
  return [...selected]
    .sort((left, right) => left - right)
    .map((index) => all[index]!);
}

function signalExample(
  kind: LearningSignalKind,
  sample: PublishedSample,
): string | null {
  if (kind === "hook") return clean(opening(sample.post.body), 2_000);
  if (kind === "topic") {
    return clean(sample.post.title) ?? clean(opening(sample.post.body), 2_000);
  }
  return clean(sample.descriptors[kind], 2_000);
}

export function calculatePublishedSignals(input: {
  samples: PublishedSample[];
  calculatedAt: string;
}): LearningSignal[] {
  const samples = [...input.samples].sort((left, right) =>
    compareText(left.post.id, right.post.id),
  );
  const kinds: LearningSignalKind[] = [
    "topic",
    "format",
    "hook",
    "cta",
    "source_pattern",
  ];
  const signals: LearningSignal[] = [];
  for (const kind of kinds) {
    const groups = new Map<string, SignalMember[]>();
    for (const sample of samples) {
      const key = clean(sample.descriptors[kind]);
      if (!key) continue;
      const normalized = key.toLowerCase();
      groups.set(normalized, [
        ...(groups.get(normalized) ?? []),
        { sample, key },
      ]);
    }
    for (const members of groups.values()) {
      const group = members.map((member) => member.sample);
      const metrics = metricScore(group, samples);
      const evidence = boundedEvidence(group);
      const representative = [...group].sort(
        (left, right) =>
          (right.analytics?.impressions ?? -1) -
            (left.analytics?.impressions ?? -1) ||
          compareText(left.post.id, right.post.id),
      )[0]!;
      const hasOutcomeEvidence = group.some(
        (sample) => sample.outcomes.length > 0,
      );
      signals.push({
        kind,
        key: members[0]!.key.slice(0, 240),
        label: members[0]!.key.slice(0, 240),
        score: metrics.score,
        confidence: Math.min(
          0.95,
          0.2 +
            Math.min(0.4, group.length * 0.08) +
            metrics.coverage * 0.25 +
            (hasOutcomeEvidence ? 0.1 : 0),
        ),
        sampleSize: group.length,
        baseline: metrics.baseline,
        trend: signalTrend(group),
        evidence,
        representativeExample: signalExample(kind, representative),
        explanation: null,
        calculatedAt: input.calculatedAt,
      });
    }
  }
  const ranked = signals.sort(
    (left, right) =>
      right.score - left.score ||
      right.confidence - left.confidence ||
      compareText(left.kind, right.kind) ||
      compareText(left.label, right.label),
  );
  const selected = new Set<LearningSignal>();
  for (const kind of kinds) {
    for (const signal of ranked.filter((item) => item.kind === kind).slice(0, 10)) {
      selected.add(signal);
    }
  }
  for (const signal of ranked) {
    if (selected.size >= 100) break;
    selected.add(signal);
  }
  return ranked.filter((signal) => selected.has(signal));
}

export function calculateVoiceSignals(input: {
  id: string;
  profile: ReturnType<typeof sanitizeVoiceProfile>;
  sourcePostCount: number;
  generatedAt: string;
  calculatedAt: string;
}): LearningSignal[] {
  const definitions: Array<{
    kind: LearningSignalKind;
    values: string[];
  }> = [
    { kind: "topic", values: input.profile.topics },
    { kind: "hook", values: input.profile.format_patterns.hook_styles },
    {
      kind: "format",
      values: [input.profile.format_patterns.structure],
    },
  ];
  const evidence: LearningEvidence[] = input.profile.exemplars.map(
    (_, exemplarIndex) => ({
      kind: "voice_exemplar",
      voiceProfileId: input.id,
      exemplarIndex,
      generatedAt: input.generatedAt,
    }),
  );
  if (evidence.length === 0) return [];
  return definitions
    .flatMap(({ kind, values }) =>
      values.flatMap((raw) => {
        const value = clean(raw);
        if (!value) return [];
        const example =
          input.profile.exemplars.find((post) =>
            post.toLowerCase().includes(value.toLowerCase()),
          ) ?? input.profile.exemplars[0]!;
        return [
          {
            kind,
            key: value.toLowerCase(),
            label: value,
            score: 0,
            confidence: Math.min(
              0.8,
              0.25 + Math.min(input.sourcePostCount, 20) * 0.025,
            ),
            sampleSize: Math.max(1, input.sourcePostCount),
            baseline: null,
            trend: "unknown" as const,
            evidence: evidence.slice(0, 200),
            representativeExample: clean(
              kind === "hook" ? opening(example) : example,
              2_000,
            ),
            explanation: null,
            calculatedAt: input.calculatedAt,
          },
        ];
      }),
    )
    .slice(0, 100);
}

async function loadCurrent(
  db: SupabaseClient,
  workspaceId: string,
  status: "active" | "shadow",
): Promise<WorkspaceLearningModel | null> {
  const { data, error } = await db
    .from("workspace_learning_snapshots")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("status", status)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const model = learningFromRow(data as LearningRow);
  if (!model) throw new Error("Stored Workspace Learning snapshot is invalid");
  return model;
}

async function loadPublishedPostCount(
  db: SupabaseClient,
  workspaceId: string,
): Promise<number> {
  const { count, error } = await db
    .from("chat_artifacts")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .or("status.eq.posted,schedule_status.eq.published");
  if (error) throw error;
  return typeof count === "number" ? count : 0;
}

async function loadPublishedCorpus(
  db: SupabaseClient,
  workspaceId: string,
): Promise<{ count: number; posts: PublishedRow[] }> {
  const filter = "status.eq.posted,schedule_status.eq.published";
  const columns =
    "id, title, body, status, schedule_status, published_at, created_at, media_attachments";
  const [countResult, scheduledResult, postedResult] = await Promise.all([
    db
      .from("chat_artifacts")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .or(filter),
    db
      .from("chat_artifacts")
      .select(columns)
      .eq("workspace_id", workspaceId)
      .eq("schedule_status", "published")
      .order("published_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(PUBLISHED_SAMPLE_LIMIT),
    db
      .from("chat_artifacts")
      .select(columns)
      .eq("workspace_id", workspaceId)
      .eq("status", "posted")
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(PUBLISHED_SAMPLE_LIMIT),
  ]);
  if (countResult.error) throw countResult.error;
  if (scheduledResult.error) throw scheduledResult.error;
  if (postedResult.error) throw postedResult.error;
  const posts = selectRecentPublishedPosts(
    (scheduledResult.data ?? []) as PublishedRow[],
    (postedResult.data ?? []) as PublishedRow[],
  );
  return {
    count:
      typeof countResult.count === "number"
        ? countResult.count
        : posts.length,
    posts,
  };
}

async function loadPublishedSamples(
  db: SupabaseClient,
  workspaceId: string,
  posts: PublishedRow[],
): Promise<PublishedSample[]> {
  if (posts.length === 0) return [];
  const ids = posts.map((post) => post.id);
  const [lineageResult, evidenceResult] = await Promise.all([
    db
      .from("artifact_lineage")
      .select("id, artifact_id, origin, inputs, descriptor")
      .eq("workspace_id", workspaceId)
      .in("artifact_id", ids),
    db.rpc("get_workspace_learning_evidence", {
      p_workspace_id: workspaceId,
      p_artifact_ids: ids,
    }),
  ]);
  for (const result of [lineageResult, evidenceResult]) {
    if (result.error) throw result.error;
  }
  const lineages = new Map(
    ((lineageResult.data ?? []) as LineageRow[]).map((row) => [
      row.artifact_id,
      row,
    ]),
  );
  const analytics = new Map<string, AnalyticsRow>();
  const revisions = new Map<string, RevisionRow[]>();
  const outcomes = new Map<string, OutcomeRow[]>();
  for (const row of (evidenceResult.data ?? []) as EvidenceRow[]) {
    if (row.analytics_id && row.analytics_fetched_at) {
      analytics.set(row.artifact_id, {
        artifact_id: row.artifact_id,
        impressions: row.impressions,
        likes: row.likes,
        comments: row.comments,
        shares: row.shares,
        fetched_at: row.analytics_fetched_at,
      });
    }
    if (row.revision_id) {
      revisions.set(row.artifact_id, [
        {
          id: row.revision_id,
          saved_artifact_id: row.artifact_id,
          source_artifact_id: row.artifact_id,
        },
      ]);
    }
    if (
      row.outcome_id &&
      row.outcome_kind &&
      row.outcome_source &&
      row.outcome_confidence !== null &&
      row.outcome_quantity !== null
    ) {
      const current = outcomes.get(row.artifact_id) ?? [];
      if (!current.some((outcome) => outcome.id === row.outcome_id)) {
        current.push({
          id: row.outcome_id,
          draft_id: row.artifact_id,
          kind: row.outcome_kind,
          source: row.outcome_source,
          confidence: row.outcome_confidence,
          quantity: row.outcome_quantity,
          amount_minor: row.outcome_amount_minor,
          currency: row.outcome_currency,
        });
        outcomes.set(row.artifact_id, current);
      }
    }
  }
  return posts.map((post) => {
    const lineage = lineages.get(post.id) ?? null;
    return {
      post,
      lineage,
      analytics: analytics.get(post.id) ?? null,
      revisions: revisions.get(post.id) ?? [],
      outcomes: outcomes.get(post.id) ?? [],
      publishedAt: post.published_at,
      descriptors: publishedDescriptors(post, lineage),
    };
  });
}

async function calculateSnapshot(
  db: SupabaseClient,
  workspaceId: string,
  asOf: string,
): Promise<{
  sourceMode: WorkspaceLearningModel["sourceMode"];
  publishedPostCount: number;
  fingerprint: string;
  signals: LearningSignal[];
} | null> {
  const published = await loadPublishedCorpus(db, workspaceId);
  if (published.count < 5) {
    const { data, error } = await db
      .from("voice_profiles")
      .select("id, profile, source_post_count, generated_at")
      .eq("workspace_id", workspaceId)
      .eq("status", "ready")
      .maybeSingle();
    if (error) throw error;
    if (
      !data ||
      typeof data.id !== "string" ||
      typeof data.source_post_count !== "number" ||
      typeof data.generated_at !== "string"
    ) {
      return null;
    }
    const profile = sanitizeVoiceProfile(data.profile);
    const fingerprintInput = {
      sourceMode: "voice_exemplars",
      publishedPostCount: published.count,
      voiceProfileId: data.id,
      sourcePostCount: data.source_post_count,
      generatedAt: data.generated_at,
      topics: profile.topics,
      hookStyles: profile.format_patterns.hook_styles,
      structure: profile.format_patterns.structure,
      exemplars: profile.exemplars,
    };
    return {
      sourceMode: "voice_exemplars",
      publishedPostCount: published.count,
      fingerprint: workspaceLearningFingerprint(fingerprintInput),
      signals: calculateVoiceSignals({
        id: data.id,
        profile,
        sourcePostCount: data.source_post_count,
        generatedAt: data.generated_at,
        calculatedAt: asOf,
      }),
    };
  }

  const samples = await loadPublishedSamples(
    db,
    workspaceId,
    published.posts,
  );
  const fingerprintInput = {
    sourceMode: "published_posts",
    publishedPostCount: published.count,
    samples: samples.map((sample) => ({
      id: sample.post.id,
      body: sample.post.body,
      title: sample.post.title,
      publishedAt: sample.publishedAt,
      media: sample.post.media_attachments,
      lineage: sample.lineage,
      analytics: sample.analytics,
      revisions: sample.revisions.map((revision) => revision.id),
      outcomes: sample.outcomes,
    })),
  };
  return {
    sourceMode: "published_posts",
    publishedPostCount: published.count,
    fingerprint: workspaceLearningFingerprint(fingerprintInput),
    signals: calculatePublishedSignals({
      samples,
      calculatedAt: asOf,
    }),
  };
}

export function createWorkspaceLearningStore(
  db: SupabaseClient,
  onFailure: (operation: string, error: unknown) => void = (
    operation,
    error,
  ) =>
    console.warn("[workspace-learning] operation failed", {
      operation,
      error: error instanceof Error ? error.message : String(error),
    }),
): WorkspaceLearning {
  return {
    async get(workspaceId) {
      try {
        return (
          (await loadCurrent(db, workspaceId, "active")) ??
          (await loadCurrent(db, workspaceId, "shadow"))
        );
      } catch (error) {
        onFailure("get", error);
        return null;
      }
    },
    async refresh(
      workspaceId: string,
      options: RefreshWorkspaceLearningOptions = {},
    ) {
      const targetStatus = options.mode ?? "shadow";
      let current: WorkspaceLearningModel | null = null;
      try {
        // These two reads are independent — fire them together so every
        // refresh costs one round trip, not two. allSettled (not Promise.all)
        // keeps the sequential version's exact partial-failure behavior: a
        // loaded snapshot is still returned when only the count read fails,
        // and the first error in original order is what the catch reports.
        const [currentResult, countResult] = await Promise.allSettled([
          loadCurrent(db, workspaceId, targetStatus),
          loadPublishedPostCount(db, workspaceId),
        ]);
        if (currentResult.status === "fulfilled") current = currentResult.value;
        if (currentResult.status === "rejected") throw currentResult.reason;
        if (countResult.status === "rejected") throw countResult.reason;
        const publishedPostCount = countResult.value;
        const asOf = options.asOf ?? new Date().toISOString();
        const asOfMs = Date.parse(asOf);
        const expectedSourceMode =
          publishedPostCount < 5
            ? "voice_exemplars"
            : "published_posts";
        if (
          !options.force &&
          current?.status === targetStatus &&
          current.sourceMode === expectedSourceMode &&
          current.calculationVersion ===
            WORKSPACE_LEARNING_CALCULATION_VERSION &&
          asOfMs - Date.parse(current.calculatedAt) <
            WORKSPACE_LEARNING_REFRESH_MS
        ) {
          return current;
        }
        if (
          !options.force &&
          !current &&
          isRecentlyIneligible(
            workspaceId,
            publishedPostCount,
            asOfMs,
          )
        ) {
          return null;
        }
        const calculated = await calculateSnapshot(
          db,
          workspaceId,
          asOf,
        );
        if (!calculated) {
          if (!current) {
            cacheIneligibleWorkspace(
              workspaceId,
              publishedPostCount,
              asOfMs,
            );
          }
          return current;
        }
        ineligibleWorkspaces.delete(workspaceId);
        const candidate = workspaceLearningModelSchema.parse({
          schemaVersion: CONTENT_LEARNING_SCHEMA_VERSION,
          id: "pending",
          workspaceId,
          version: Math.max(1, (current?.version ?? 0) + 1),
          status: targetStatus,
          sourceMode: calculated.sourceMode,
          publishedPostCount: calculated.publishedPostCount,
          calculationVersion: WORKSPACE_LEARNING_CALCULATION_VERSION,
          inputFingerprint: calculated.fingerprint,
          signals: calculated.signals,
          calculatedAt: asOf,
          createdAt: asOf,
        });
        const { data, error } = await db.rpc(
          "persist_workspace_learning_snapshot",
          {
            p_workspace_id: workspaceId,
            p_status: targetStatus,
            p_source_mode: candidate.sourceMode,
            p_published_post_count: candidate.publishedPostCount,
            p_calculation_version: candidate.calculationVersion,
            p_input_fingerprint: candidate.inputFingerprint,
            p_signals: candidate.signals,
            p_calculated_at: candidate.calculatedAt,
          },
        );
        if (error) throw error;
        const row = Array.isArray(data) ? data[0] : data;
        const stored = row
          ? learningFromRow(row as LearningRow)
          : null;
        if (!stored) throw new Error("Workspace Learning write was invalid");
        return stored;
      } catch (error) {
        onFailure("refresh", error);
        return current;
      }
    },
  };
}
