import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, test, vi } from "vitest";
import { sanitizeVoiceProfile } from "@/lib/claude";
import {
  calculatePublishedSignals,
  calculateVoiceSignals,
  createWorkspaceLearningStore,
  selectRecentPublishedPosts,
  type PublishedRow,
  workspaceLearningFingerprint,
} from "@/lib/content-learning/workspace-learning";

const at = "2026-07-26T14:00:00.000Z";

const storedSnapshot = {
  id: "50000000-0000-4000-8000-000000000001",
  schema_version: 1,
  workspace_id: "workspace-1",
  version: 3,
  status: "active",
  source_mode: "published_posts",
  published_post_count: 5,
  calculation_version: "workspace-learning-v1",
  input_fingerprint: "sha256:existing",
  signals: [],
  calculated_at: "2026-07-10T14:00:00.000Z",
  created_at: "2026-07-10T14:00:00.000Z",
};

function chain<T>(terminal: T) {
  const builder = {
    select: vi.fn(),
    eq: vi.fn(),
    or: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    maybeSingle: vi.fn(async () => terminal),
    then: vi.fn(
      (
        resolve: (value: T) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => Promise.resolve(terminal).then(resolve, reject),
    ),
  };
  for (const method of ["select", "eq", "or", "order", "limit"] as const) {
    builder[method].mockReturnValue(builder);
  }
  return builder;
}

function sample(input: {
  id: string;
  topic: string;
  impressions: number;
  outcome?: string;
  revision?: string;
  hook?: string;
  format?: string;
  cta?: string;
  source?: string;
  publishedAt?: string | null;
}) {
  return {
    post: {
      id: input.id,
      title: input.topic,
      body: `${input.topic} is the operating lesson.\n\nHere is the proof.`,
      status: "posted",
      schedule_status: null,
      published_at: at,
      created_at: at,
      media_attachments: [],
    },
    lineage: {
      id: `lineage-${input.id}`,
      artifact_id: input.id,
      origin: { kind: input.source ?? "cowork" },
      inputs: {},
      descriptor: {
        topic: input.topic,
        hookType: input.hook ?? "Direct claim",
        structure: input.format ?? "Proof-led",
        ctaType: input.cta ?? "No explicit CTA",
      },
    },
    analytics: {
      artifact_id: input.id,
      impressions: input.impressions,
      likes: 1,
      comments: 1,
      shares: 0,
      fetched_at: at,
    },
    revisions: input.revision
      ? [
          {
            id: input.revision,
            saved_artifact_id: input.id,
            source_artifact_id: input.id,
          },
        ]
      : [],
    outcomes: input.outcome
      ? [{ id: input.outcome, draft_id: input.id, quantity: 1 }]
      : [],
    publishedAt:
      input.publishedAt === undefined ? at : input.publishedAt,
    descriptors: {
      topic: input.topic,
      hook: input.hook ?? "Direct claim",
      format: input.format ?? "Proof-led",
      cta: input.cta ?? "No explicit CTA",
      source_pattern: input.source ?? "cowork",
      voice_preference: null,
    },
  };
}

function publishedRow(
  id: string,
  input: { publishedAt: string | null; createdAt: string },
): PublishedRow {
  return {
    id,
    title: id,
    body: id,
    status: "posted",
    schedule_status: input.publishedAt ? "published" : null,
    published_at: input.publishedAt,
    created_at: input.createdAt,
    media_attachments: [],
  };
}

describe("deterministic Workspace Learning calculator", () => {
  test("fingerprints equivalent inputs independently of object key order", () => {
    expect(workspaceLearningFingerprint({ b: 2, a: [1, { d: 4, c: 3 }] }))
      .toBe(
        workspaceLearningFingerprint({
          a: [1, { c: 3, d: 4 }],
          b: 2,
        }),
      );
  });

  test("keeps newer manual posts in the latest corpus", () => {
    const scheduled = Array.from({ length: 50 }, (_, index) =>
      publishedRow(`scheduled-${String(index).padStart(2, "0")}`, {
        publishedAt: `2026-06-${String((index % 28) + 1).padStart(2, "0")}T12:00:00.000Z`,
        createdAt: "2026-05-01T12:00:00.000Z",
      }),
    );
    const manual = publishedRow("manual-newest", {
      publishedAt: null,
      createdAt: "2026-07-26T12:00:00.000Z",
    });
    const selected = selectRecentPublishedPosts(scheduled, [manual]);

    expect(selected).toHaveLength(50);
    expect(selected[0]?.id).toBe("manual-newest");
    expect(selected.some((post) => post.id === "manual-newest")).toBe(true);
  });

  test("scores descriptors from measured performance and links every evidence type", () => {
    const signals = calculatePublishedSignals({
      samples: [
        sample({
          id: "10000000-0000-4000-8000-000000000001",
          topic: "Founder systems",
          impressions: 2_000,
          outcome: "20000000-0000-4000-8000-000000000001",
          revision: "30000000-0000-4000-8000-000000000001",
        }),
        sample({
          id: "10000000-0000-4000-8000-000000000002",
          topic: "Founder systems",
          impressions: 1_500,
        }),
        sample({
          id: "10000000-0000-4000-8000-000000000003",
          topic: "Generic news",
          impressions: 200,
        }),
      ],
      calculatedAt: at,
    });
    const topic = signals.find(
      (signal) =>
        signal.kind === "topic" && signal.label === "Founder systems",
    );
    expect(topic).toMatchObject({
      sampleSize: 2,
      trend: "up",
    });
    expect(topic!.score).toBeGreaterThan(0);
    expect(topic!.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "lineage" }),
        expect.objectContaining({ kind: "publication" }),
        expect.objectContaining({ kind: "performance", value: 2_000 }),
        expect.objectContaining({ kind: "revision" }),
        expect.objectContaining({ kind: "outcome" }),
      ]),
    );
  });

  test("uses Voice exemplars without inventing performance", () => {
    const profile = sanitizeVoiceProfile({
      topics: ["Founder systems"],
      format_patterns: {
        hook_styles: ["Concrete reversal"],
        structure: "Claim, proof, takeaway",
      },
      exemplars: [
        "I stopped measuring reach.\n\nHere is what I track instead.",
      ],
    });
    const signals = calculateVoiceSignals({
      id: "40000000-0000-4000-8000-000000000001",
      profile,
      sourcePostCount: 12,
      generatedAt: at,
      calculatedAt: at,
    });
    expect(signals.map((signal) => signal.kind)).toEqual([
      "topic",
      "hook",
      "format",
    ]);
    expect(signals.every((signal) => signal.score === 0)).toBe(true);
    expect(signals.every((signal) => signal.trend === "unknown")).toBe(true);
    expect(signals[0]!.evidence[0]).toMatchObject({
      kind: "voice_exemplar",
      exemplarIndex: 0,
    });
  });

  test("is deterministic across input order and caps maximum-cardinality corpora", () => {
    const samples = Array.from({ length: 50 }, (_, index) =>
      sample({
        id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        topic: `Topic ${index + 1}`,
        hook: `Hook ${index + 1}`,
        format: `Format ${index + 1}`,
        cta: `CTA ${index + 1}`,
        source: `Source ${index + 1}`,
        impressions: 100 + index,
        outcome:
          index === 49
            ? "20000000-0000-4000-8000-000000000050"
            : undefined,
        revision: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      }),
    );
    const forward = calculatePublishedSignals({
      samples,
      calculatedAt: at,
    });
    const reversed = calculatePublishedSignals({
      samples: [...samples].reverse(),
      calculatedAt: at,
    });

    expect(forward).toHaveLength(100);
    expect(reversed).toEqual(forward);
    expect(new Set(forward.map((signal) => signal.kind))).toEqual(
      new Set(["topic", "format", "hook", "cta", "source_pattern"]),
    );
    expect(
      forward.some((signal) =>
        signal.evidence.some((item) => item.kind === "outcome"),
      ),
    ).toBe(true);
  });

  test("represents an unknown publication time without using it for trends", () => {
    const signals = calculatePublishedSignals({
      samples: [
        sample({
          id: "10000000-0000-4000-8000-000000000071",
          topic: "Founder systems",
          impressions: 2_000,
          publishedAt: null,
        }),
        sample({
          id: "10000000-0000-4000-8000-000000000072",
          topic: "Founder systems",
          impressions: 200,
          publishedAt: null,
        }),
      ],
      calculatedAt: at,
    });
    const topic = signals.find(
      (signal) =>
        signal.kind === "topic" && signal.label === "Founder systems",
    )!;
    expect(topic.trend).toBe("unknown");
    expect(topic.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "publication",
          publishedAt: null,
        }),
      ]),
    );
  });

  test("keeps the last valid snapshot when a refresh dependency fails", async () => {
    const current = chain({ data: storedSnapshot, error: null });
    const publishedCount = chain({
      count: null,
      error: new Error("analytics database unavailable"),
    });
    const onFailure = vi.fn();
    const db = {
      from: vi.fn((table: string) =>
        table === "workspace_learning_snapshots"
          ? current
          : publishedCount,
      ),
    } as unknown as SupabaseClient;

    await expect(
      createWorkspaceLearningStore(db, onFailure).refresh("workspace-1", {
        mode: "active",
        force: true,
        asOf: at,
      }),
    ).resolves.toMatchObject({
      id: storedSnapshot.id,
      version: 3,
      inputFingerprint: "sha256:existing",
    });
    expect(onFailure).toHaveBeenCalledWith(
      "refresh",
      expect.objectContaining({
        message: "analytics database unavailable",
      }),
    );
  });

  test("briefly caches an unchanged ineligible workspace without hiding a new fifth post", async () => {
    const emptySnapshot = chain({ data: null, error: null });
    const missingVoice = chain({ data: null, error: null });
    let publishedCount = 0;
    const from = vi.fn((table: string) => {
      if (table === "workspace_learning_snapshots") {
        return emptySnapshot;
      }
      if (table === "voice_profiles") return missingVoice;
      return chain({
        data: [],
        count: publishedCount,
        error: null,
      });
    });
    const db = {
      from,
      rpc: vi.fn(async () => ({
        data: {
          ...storedSnapshot,
          published_post_count: 5,
          calculated_at: at,
          created_at: at,
        },
        error: null,
      })),
    } as unknown as SupabaseClient;
    const store = createWorkspaceLearningStore(db);
    const workspaceId = "workspace-ineligible-cache";

    await expect(
      store.refresh(workspaceId, {
        mode: "active",
        asOf: at,
      }),
    ).resolves.toBeNull();
    await expect(
      store.refresh(workspaceId, {
        mode: "active",
        asOf: at,
      }),
    ).resolves.toBeNull();
    expect(from).toHaveBeenCalledWith("voice_profiles");
    expect(
      from.mock.calls.filter(([table]) => table === "voice_profiles"),
    ).toHaveLength(1);

    publishedCount = 5;
    await expect(
      store.refresh(workspaceId, {
        mode: "active",
        asOf: at,
      }),
    ).resolves.toMatchObject({
      sourceMode: "published_posts",
      publishedPostCount: 5,
    });
    expect(
      from.mock.calls.filter(([table]) => table === "chat_artifacts")
        .length,
    ).toBeGreaterThan(5);
  });
});
