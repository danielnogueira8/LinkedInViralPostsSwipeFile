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

  test("a Hook edit from an Ask answer keeps the exact Hook target and edit mode", () => {
    expect(
      resolveFreeTextArtifactIntent({
        message: "Tighten this hook.",
        artifacts: [artifact("draft-1"), artifact("hook-1", "hook")],
        selectedArtifactId: "hook-1",
      }),
    ).toEqual({
      kind: "operation",
      operation: {
        kind: "edit_artifact",
        artifactId: "hook-1",
        instruction: "Tighten this hook.",
        editMode: "general",
      },
    });
  });

  test.each([
    "Can you improve this draft?",
    "Give me feedback on Draft 1 and then rewrite it.",
    "Summarize Draft 1, then rewrite it.",
    "Explain the weaknesses in Draft 1 and fix them.",
    "Rate Draft 1, then improve it.",
    "Tell me what works in Draft 1, then rewrite it.",
  ])("a direct or compound mutation compiles to an edit: %s", (message) => {
    expect(
      resolveFreeTextArtifactIntent({
        message,
        artifacts: [artifact("draft-1")],
        selectedArtifactId: "draft-1",
      }),
    ).toMatchObject({
      kind: "operation",
      operation: {
        kind: "edit_artifact",
        artifactId: "draft-1",
      },
    });
  });

  test.each([
    "How can I improve this draft?",
    "Can you explain how to improve this draft?",
    "Could you tell me how to improve this draft?",
    "Can you give me feedback on how to improve this draft?",
    "Review Draft 1 and tell me how to improve it.",
    "Tell me what works in Draft 1 and what I should improve.",
    "Review this draft and explain why you would improve the hook.",
    "Tell me what works in Draft 1 and which parts I should improve.",
    "Tell me what works in Draft 1 and where I should improve.",
    "Review this draft and explain if I should improve the hook.",
  ])("advice about improving remains a read-only review: %s", (message) => {
    expect(
      resolveFreeTextArtifactIntent({
        message,
        artifacts: [artifact("draft-1")],
        selectedArtifactId: "draft-1",
      }),
    ).toEqual({
      kind: "operation",
      operation: { kind: "review_artifact", artifactId: "draft-1" },
    });
  });

  test.each([
    "Add another example to this draft.",
    "Add another paragraph to the post.",
  ])("\"another\" inside an Artifact edit does not create a new Artifact: %s", (message) => {
    expect(
      resolveFreeTextArtifactIntent({
        message,
        artifacts: [artifact("draft-1")],
        selectedArtifactId: "draft-1",
      }),
    ).toMatchObject({
      kind: "operation",
      operation: { kind: "edit_artifact", artifactId: "draft-1" },
    });
  });

  test("a negated new-draft phrase cannot override the affirmative edit clause", () => {
    expect(
      resolveFreeTextArtifactIntent({
        message: "Do not make another draft; rewrite this one.",
        artifacts: [artifact("draft-1")],
        selectedArtifactId: "draft-1",
      }),
    ).toMatchObject({
      kind: "operation",
      operation: { kind: "edit_artifact", artifactId: "draft-1" },
    });
  });

  test("a stale selected Artifact fails closed instead of editing the latest one", () => {
    expect(
      resolveFreeTextArtifactIntent({
        message: "Make this punchier.",
        artifacts: [artifact("draft-1"), artifact("draft-2")],
        selectedArtifactId: "deleted-draft",
      }).kind,
    ).toBe("clarification");
  });

  test("word ordinals resolve the explicitly named Artifact instead of selected context", () => {
    expect(
      resolveFreeTextArtifactIntent({
        message: "Rewrite the first draft.",
        artifacts: [artifact("post-1"), artifact("post-2")],
        selectedArtifactId: "post-2",
      }),
    ).toMatchObject({
      kind: "operation",
      operation: { kind: "edit_artifact", artifactId: "post-1" },
    });

    expect(
      resolveFreeTextArtifactIntent({
        message: "Review the second hook.",
        artifacts: [artifact("hook-1", "hook"), artifact("hook-2", "hook")],
        selectedArtifactId: "hook-1",
      }),
    ).toEqual({
      kind: "operation",
      operation: { kind: "review_artifact", artifactId: "hook-2" },
    });
  });

  test("a compound word ordinal never degrades to its suffix ordinal", () => {
    expect(
      resolveFreeTextArtifactIntent({
        message: "Rewrite the twenty-first draft.",
        artifacts: [artifact("post-1"), artifact("post-2")],
        selectedArtifactId: "post-1",
      }),
    ).toMatchObject({ kind: "clarification" });
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

  test.each([
    "Rewrite it as version 3.",
    "Rewrite it as v12.",
    "Rewrite it as the third version.",
    "Rewrite it as the sixth version.",
    "Rewrite it as version eleven.",
    "Review Draft 1, then create another version.",
    "Make it a list-format variation.",
  ])("an explicit request for a separate version stays on normal creation routing: %s", (message) => {
    expect(
      resolveFreeTextArtifactIntent({
        message,
        artifacts: [artifact("draft-1")],
        selectedArtifactId: "draft-1",
      }),
    ).toEqual({ kind: "none" });
  });

  test("clarification language uses the human-facing post term", () => {
    const result = resolveFreeTextArtifactIntent({
      message: "Rewrite Draft 9.",
      artifacts: [artifact("draft-1")],
      selectedArtifactId: null,
    });
    expect(result.kind).toBe("clarification");
    if (result.kind !== "clarification") return;
    expect(result.clarification.question).toContain("post");
    expect(result.clarification.question).not.toContain("Artifact");
    expect(result.clarification.options.join(" ")).not.toContain("Artifact");
  });
});
