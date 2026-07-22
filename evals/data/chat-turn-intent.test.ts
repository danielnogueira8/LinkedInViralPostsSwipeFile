import { describe, expect, test } from "vitest";
import type { Artifact } from "@/lib/agent/contracts";
import { chatTurnRequestSchema } from "@/lib/agent/chat-turn";
import { resolveFreeTextArtifactIntent } from "@/lib/agent/turn/resolve-artifact-intent";

const artifact = (id: string, kind: "post" | "hook" = "post"): Artifact => ({
  id,
  kind,
  title: id,
  body: `${id} body`,
});

describe("server-owned free-text Artifact intent", () => {
  test("the request contract transports selected Artifact context without an operation", () => {
    expect(
      chatTurnRequestSchema.parse({
        message: "Make this punchier.",
        selectedArtifactId: "draft-1",
      }),
    ).toEqual({
      message: "Make this punchier.",
      selectedArtifactId: "draft-1",
    });
  });

  test("a compound review and improvement resolves once to an exact edit operation", () => {
    expect(
      resolveFreeTextArtifactIntent({
        message: "Review Draft 1 and improve the hook.",
        artifacts: [artifact("draft-1"), artifact("draft-2")],
        selectedArtifactId: "draft-2",
      }),
    ).toEqual({
      kind: "operation",
      operation: {
        kind: "edit_artifact",
        artifactId: "draft-1",
        instruction: "Review Draft 1 and improve the hook.",
        editMode: "hook_only",
      },
    });
  });

  test("a feedback-only request compiles to a read-only operation", () => {
    expect(
      resolveFreeTextArtifactIntent({
        message: "Review Draft 1 and give feedback only.",
        artifacts: [artifact("draft-1"), artifact("draft-2")],
        selectedArtifactId: "draft-2",
      }),
    ).toEqual({
      kind: "operation",
      operation: { kind: "review_artifact", artifactId: "draft-1" },
    });
  });

  test.each([
    "Give feedback on Draft 1.",
    "Tell me what works and what does not in Draft 1.",
  ])("a common feedback command resolves its numbered Draft: %s", (message) => {
    expect(
      resolveFreeTextArtifactIntent({
        message,
        artifacts: [artifact("draft-1"), artifact("draft-2")],
        selectedArtifactId: "draft-2",
      }),
    ).toEqual({
      kind: "operation",
      operation: { kind: "review_artifact", artifactId: "draft-1" },
    });
  });

  test("a numbered Hook can be reviewed independently of Draft numbering", () => {
    expect(
      resolveFreeTextArtifactIntent({
        message: "Review Hook 1.",
        artifacts: [artifact("draft-1"), artifact("hook-1", "hook")],
        selectedArtifactId: "draft-1",
      }),
    ).toEqual({
      kind: "operation",
      operation: { kind: "review_artifact", artifactId: "hook-1" },
    });
  });

  test("an ordinary edit uses the selected Artifact context", () => {
    expect(
      resolveFreeTextArtifactIntent({
        message: "Make this punchier.",
        artifacts: [artifact("draft-1"), artifact("draft-2")],
        selectedArtifactId: "draft-1",
      }),
    ).toEqual({
      kind: "operation",
      operation: {
        kind: "edit_artifact",
        artifactId: "draft-1",
        instruction: "Make this punchier.",
        editMode: "general",
      },
    });
  });

  test.each(["Add a CTA.", "Remove the last paragraph."])(
    "a common edit command compiles without a model classifier: %s",
    (message) => {
      expect(
        resolveFreeTextArtifactIntent({
          message,
          artifacts: [artifact("draft-1")],
          selectedArtifactId: "draft-1",
        }),
      ).toEqual({
        kind: "operation",
        operation: {
          kind: "edit_artifact",
          artifactId: "draft-1",
          instruction: message,
          editMode: "general",
        },
      });
    },
  );

  test("a stale selected Artifact fails closed instead of editing the latest one", () => {
    expect(
      resolveFreeTextArtifactIntent({
        message: "Make this punchier.",
        artifacts: [artifact("draft-1"), artifact("draft-2")],
        selectedArtifactId: "deleted-draft",
      }).kind,
    ).toBe("clarification");
  });

  test("an unavailable numbered reference asks for clarification", () => {
    expect(
      resolveFreeTextArtifactIntent({
        message: "Make Draft 9 punchier.",
        artifacts: [artifact("draft-1"), artifact("draft-2")],
        selectedArtifactId: null,
      }).kind,
    ).toBe("clarification");
  });

  test("an edit request with no Artifact asks for clarification", () => {
    expect(
      resolveFreeTextArtifactIntent({
        message: "Make this punchier.",
        artifacts: [],
        selectedArtifactId: null,
      }).kind,
    ).toBe("clarification");
  });

  test("negated mutation language remains a read-only review", () => {
    expect(
      resolveFreeTextArtifactIntent({
        message: "Review this draft, but do not rewrite or edit it.",
        artifacts: [artifact("draft-1")],
        selectedArtifactId: "draft-1",
      }),
    ).toEqual({
      kind: "operation",
      operation: { kind: "review_artifact", artifactId: "draft-1" },
    });
  });

  test("an explicit new-draft request is left to normal server routing", () => {
    expect(
      resolveFreeTextArtifactIntent({
        message: "Write another draft about onboarding.",
        artifacts: [artifact("draft-1")],
        selectedArtifactId: "draft-1",
      }),
    ).toEqual({ kind: "none" });
  });

  test("an explicit new-version request is never compiled as an edit", () => {
    expect(
      resolveFreeTextArtifactIntent({
        message: "Rewrite it as a new version.",
        artifacts: [artifact("draft-1")],
        selectedArtifactId: "draft-1",
      }),
    ).toEqual({ kind: "none" });
  });
});
