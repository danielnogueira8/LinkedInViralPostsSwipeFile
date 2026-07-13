import { describe, expect, test } from "vitest";
import {
  PIPELINE_KINDS,
  PipelineKindSchema,
  SourceScoutResultSchema,
  VoiceContextSchema,
  WriterResultSchema,
  EditorResultSchema,
  QaResultSchema,
  ImageAgentResultSchema,
  DraftProvenanceSchema,
  AI_TELL_CATEGORIES,
  createAgentResultSchema,
  createAgentTaskSchema,
} from "@/lib/agent/specialists/contracts";
import { z } from "zod";

// A real RFC-4122 v4 UUID (matches Postgres gen_random_uuid() output). Zod's
// .uuid() enforces the version/variant nibbles, so an all-ones string is
// (correctly) rejected — use a genuine v4 here.
const UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("PipelineKind", () => {
  test("accepts every declared pipeline kind", () => {
    for (const k of PIPELINE_KINDS) {
      expect(PipelineKindSchema.safeParse(k).success).toBe(true);
    }
  });

  test("rejects an unknown pipeline", () => {
    expect(PipelineKindSchema.safeParse("teleport_post").success).toBe(false);
  });
});

describe("pipeline envelopes", () => {
  const inputSchema = z.object({ topic: z.string().min(1) });
  const outputSchema = z.object({ body: z.string().min(1) });

  test("validates the concrete input selected for an agent task", () => {
    const schema = createAgentTaskSchema(inputSchema);

    expect(
      schema.safeParse({
        pipeline: "regular_post_from_scratch",
        workspaceId: "ws-1",
        input: { topic: "Architecture" },
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        pipeline: "regular_post_from_scratch",
        workspaceId: "ws-1",
        input: { topic: "" },
      }).success,
    ).toBe(false);
  });

  test("validates both success and failure agent results", () => {
    const schema = createAgentResultSchema(outputSchema);

    expect(schema.safeParse({ ok: true, output: { body: "Draft" } }).success).toBe(true);
    expect(schema.safeParse({ ok: false, error: "Writer failed" }).success).toBe(true);
    expect(schema.safeParse({ ok: false, error: "" }).success).toBe(false);
  });
});

describe("SourceScoutResult", () => {
  test("validates a well-formed selection", () => {
    const r = SourceScoutResultSchema.safeParse({
      posts: [
        { postId: UUID, reason: "top engagement in niche", reactions: 843, comments: 40, mediaEligible: true },
      ],
    });
    expect(r.success).toBe(true);
  });

  test("rejects a non-uuid postId", () => {
    const r = SourceScoutResultSchema.safeParse({
      posts: [{ postId: "abc", reason: "x", reactions: 1, comments: 0, mediaEligible: false }],
    });
    expect(r.success).toBe(false);
  });

  test("rejects negative engagement", () => {
    const r = SourceScoutResultSchema.safeParse({
      posts: [{ postId: UUID, reason: "x", reactions: -1, comments: 0, mediaEligible: false }],
    });
    expect(r.success).toBe(false);
  });

  test("an empty selection is valid (scout may find nothing)", () => {
    expect(SourceScoutResultSchema.safeParse({ posts: [] }).success).toBe(true);
  });
});

describe("VoiceContext", () => {
  test("ready=false with empty block is valid (no profile yet)", () => {
    const r = VoiceContextSchema.safeParse({
      ready: false,
      block: "",
      displayName: null,
      leadMagnetStyle: null,
    });
    expect(r.success).toBe(true);
  });
});

describe("WriterResult", () => {
  test("rejects an empty body", () => {
    const r = WriterResultSchema.safeParse({ kind: "regular", body: "   ", giveaway: null });
    expect(r.success).toBe(false);
  });

  test("lead_magnet body may carry giveaway metadata", () => {
    const r = WriterResultSchema.safeParse({
      kind: "lead_magnet",
      body: "Comment WORD and I'll send it.",
      giveaway: { resourceTitle: "The Kit", resourceSummary: "10 templates", cta: "Comment WORD" },
    });
    expect(r.success).toBe(true);
  });
});

describe("EditorResult", () => {
  test("only accepts declared AI-tell categories", () => {
    const good = EditorResultSchema.safeParse({
      body: "clean body",
      changed: true,
      usedModel: false,
      fixedCategories: ["em_dash", "dense_paragraph"],
      notes: [],
    });
    expect(good.success).toBe(true);

    const bad = EditorResultSchema.safeParse({
      body: "clean body",
      changed: true,
      usedModel: false,
      fixedCategories: ["sparkle"],
      notes: [],
    });
    expect(bad.success).toBe(false);
  });

  test("every declared tell category parses", () => {
    const r = EditorResultSchema.safeParse({
      body: "x",
      changed: false,
      usedModel: false,
      fixedCategories: [...AI_TELL_CATEGORIES],
      notes: [],
    });
    expect(r.success).toBe(true);
  });
});

describe("QaResult", () => {
  test("failing QA carries a repair instruction", () => {
    const r = QaResultSchema.safeParse({
      passed: false,
      checks: [{ name: "count-match", passed: false, fix: "return exactly 3 hooks" }],
      repairInstruction: "return exactly 3 hooks",
    });
    expect(r.success).toBe(true);
  });
});

describe("ImageAgentResult + DraftProvenance", () => {
  test("a skipped image is a valid, non-blocking result", () => {
    const r = ImageAgentResultSchema.safeParse({
      status: "skipped",
      attachment: null,
      reason: "no source image to adapt",
    });
    expect(r.success).toBe(true);
  });

  test("provenance is fully optional/partial", () => {
    expect(DraftProvenanceSchema.safeParse({}).success).toBe(true);
    expect(
      DraftProvenanceSchema.safeParse({
        sourcePostId: UUID,
        imageStatus: "queued",
        qaPassed: true,
        pipeline: "lead_magnet_post",
      }).success,
    ).toBe(true);
  });
});
