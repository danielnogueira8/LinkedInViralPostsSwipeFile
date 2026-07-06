import { describe, expect, test } from "vitest";
import {
  CONTENT_FEEDBACK_BODY_SNAPSHOT_MAX,
  CONTENT_FEEDBACK_INJECTED_MAX,
  CONTENT_FEEDBACK_NOTE_MAX,
  CONTENT_FEEDBACK_REASONS_MAX,
  contentFeedbackInputSchema,
  normalizeFeedbackBody,
  normalizeFeedbackNote,
  renderFeedbackMemoryBlock,
} from "@/lib/content-feedback";

describe("content feedback validation", () => {
  test("accepts valid feedback and maps API camelCase to DB snake_case", () => {
    const parsed = contentFeedbackInputSchema.parse({
      rating: "down",
      reasons: ["Too generic", "Bad hook"],
      note: "  make it sharper\nnext time ",
      bodySnapshot: " draft body ",
      chatId: "00000000-0000-4000-8000-000000000001",
      artifactId: "artifact_1",
      draftId: "00000000-0000-4000-8000-000000000002",
    });

    expect(parsed).toMatchObject({
      rating: "down",
      reasons: ["Too generic", "Bad hook"],
      note: "make it sharper next time",
      body_snapshot: "draft body",
      chat_id: "00000000-0000-4000-8000-000000000001",
      artifact_id: "artifact_1",
      draft_id: "00000000-0000-4000-8000-000000000002",
    });
  });

  test("dedupes and caps reasons", () => {
    const parsed = contentFeedbackInputSchema.parse({
      rating: "up",
      reasons: [
        "Great hook",
        "Great hook",
        "Right voice",
        "Good structure",
        "Good CTA",
        "More like this",
      ],
      bodySnapshot: "body",
    });

    expect(parsed.reasons).toEqual([
      "Great hook",
      "Right voice",
      "Good structure",
      "Good CTA",
    ]);
    expect(parsed.reasons.length).toBe(CONTENT_FEEDBACK_REASONS_MAX);
  });

  test("rejects unknown ratings and reasons", () => {
    expect(
      contentFeedbackInputSchema.safeParse({
        rating: "meh",
        bodySnapshot: "body",
      }).success,
    ).toBe(false);
    expect(
      contentFeedbackInputSchema.safeParse({
        rating: "down",
        reasons: ["Make it blue"],
        bodySnapshot: "body",
      }).success,
    ).toBe(false);
  });

  test("normalizes and caps body snapshots and notes", () => {
    expect(normalizeFeedbackBody(`  ${"x".repeat(CONTENT_FEEDBACK_BODY_SNAPSHOT_MAX + 50)}  `).length).toBe(
      CONTENT_FEEDBACK_BODY_SNAPSHOT_MAX,
    );
    expect(normalizeFeedbackNote(` a\n ${"b".repeat(CONTENT_FEEDBACK_NOTE_MAX + 50)}`)?.length).toBe(
      CONTENT_FEEDBACK_NOTE_MAX,
    );
  });

  test("rejects empty body snapshots after trim", () => {
    expect(
      contentFeedbackInputSchema.safeParse({
        rating: "up",
        bodySnapshot: "   ",
      }).success,
    ).toBe(false);
  });
});

describe("renderFeedbackMemoryBlock", () => {
  test("empty / null -> empty string", () => {
    expect(renderFeedbackMemoryBlock([])).toBe("");
    expect(renderFeedbackMemoryBlock(null)).toBe("");
    expect(renderFeedbackMemoryBlock(undefined)).toBe("");
  });

  test("renders positive and negative feedback as soft guidance", () => {
    const block = renderFeedbackMemoryBlock([
      {
        rating: "up",
        reasons: ["Great hook", "Right voice"],
        note: null,
        body_snapshot: "Strong opener.\n\nSpecific story.",
      },
      {
        rating: "down",
        reasons: ["Too generic"],
        note: "avoid vague AI language",
        body_snapshot: "This post unlocks your potential.",
      },
    ]);

    expect(block).toContain("soft guidance");
    expect(block).toContain("Do more of:");
    expect(block).toContain("Great hook, Right voice");
    expect(block).toContain("Avoid:");
    expect(block).toContain("Too generic");
    expect(block).toContain("avoid vague AI language");
  });

  test("caps injected rows", () => {
    const block = renderFeedbackMemoryBlock(
      Array.from({ length: CONTENT_FEEDBACK_INJECTED_MAX + 5 }, (_, i) => ({
        rating: "up" as const,
        reasons: ["More like this" as const],
        note: null,
        body_snapshot: `Example ${i}`,
      })),
    );

    const bulletCount = block.split("\n").filter((l) => l.startsWith("- ")).length;
    expect(bulletCount).toBe(CONTENT_FEEDBACK_INJECTED_MAX);
    expect(block).not.toContain(`Example ${CONTENT_FEEDBACK_INJECTED_MAX}`);
  });

  test("skips invalid legacy reasons and blank snapshots", () => {
    const block = renderFeedbackMemoryBlock([
      {
        rating: "down",
        reasons: ["Unknown" as never],
        note: null,
        body_snapshot: "   ",
      },
      {
        rating: "down",
        reasons: ["Bad hook"],
        note: null,
        body_snapshot: "Needs a sharper start.",
      },
    ]);

    expect(block).toContain("Bad hook");
    expect(block).toContain("Needs a sharper start");
    expect(block).not.toContain("Unknown");
  });
});
