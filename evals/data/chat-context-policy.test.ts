import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { chatTurnRequestSchema } from "@/lib/agent/chat-turn";

describe("chat context policy", () => {
  test("context inheritance is opt-in and typed", () => {
    const parsed = chatTurnRequestSchema.parse({
      message: "Make it shorter.",
      contextPolicy: { inherit: ["skills", "creator_style"] },
    });

    expect(parsed.contextPolicy?.inherit).toEqual([
      "skills",
      "creator_style",
    ]);
  });

  test("the same context cannot be inherited and cleared in one turn", () => {
    expect(
      chatTurnRequestSchema.safeParse({
        message: "Start fresh.",
        contextPolicy: {
          inherit: ["post_format"],
          clear: ["post_format"],
        },
      }).success,
    ).toBe(false);
  });

  test("the production composer stamps explicit clears for unselected context", () => {
    const source = readFileSync(
      "app/(app)/dashboard/chat-workspace.tsx",
      "utf8",
    );

    expect(source).toContain("contextPolicy: {");
    expect(source).toContain('["skills"]');
    expect(source).toContain('["creator_style"]');
    expect(source).toContain('["post_format"]');
  });
});

describe("typed chat operations", () => {
  test("accepts an immutable edit operation with artifact identity", () => {
    expect(
      chatTurnRequestSchema.parse({
        message: "Make it shorter.",
        operation: {
          kind: "edit_artifact",
          artifactId: "draft-123",
          instruction: "Make it shorter.",
        },
      }).operation,
    ).toEqual({
      kind: "edit_artifact",
      artifactId: "draft-123",
      instruction: "Make it shorter.",
    });
  });
});
