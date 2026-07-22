import { describe, expect, test } from "vitest";
import {
  commandForComposer,
  commandToTurnOperation,
  coworkCommandSchema,
  resumesPersistedCoworkOperation,
  type CoworkCommand,
} from "@/lib/cowork-command";
import { chatTurnRequestSchema } from "@/lib/agent/chat-turn";

describe("Cowork command interface", () => {
  test("accepts the three explicit per-turn commands", () => {
    expect(coworkCommandSchema.parse({ kind: "ask" })).toEqual({ kind: "ask" });
    expect(
      coworkCommandSchema.parse({ kind: "ask", contextPostId: "post-2" }),
    ).toEqual({ kind: "ask", contextPostId: "post-2" });
    expect(coworkCommandSchema.parse({ kind: "create", count: 3 })).toEqual({
      kind: "create",
      count: 3,
    });
    expect(
      coworkCommandSchema.parse({
        kind: "edit",
        targetPostId: "post-2",
        scope: "hook",
      }),
    ).toEqual({ kind: "edit", targetPostId: "post-2", scope: "hook" });
  });

  test("rejects ambiguous, incomplete, and over-broad commands", () => {
    expect(coworkCommandSchema.safeParse({ kind: "create" }).success).toBe(false);
    expect(
      coworkCommandSchema.safeParse({ kind: "edit", targetPostId: "post-2" })
        .success,
    ).toBe(false);
    expect(
      coworkCommandSchema.safeParse({ kind: "ask", count: 2 }).success,
    ).toBe(false);
    expect(
      coworkCommandSchema.safeParse({ kind: "manage", action: "delete" }).success,
    ).toBe(false);
  });

  test.each<{
    command: CoworkCommand;
    instruction: string;
    expected: ReturnType<typeof commandToTurnOperation>;
  }>([
    {
      command: { kind: "ask" },
      instruction: "Rewrite the second post",
      expected: { kind: "ask" },
    },
    {
      command: { kind: "ask", contextPostId: "post-2" },
      instruction: "Rewrite this",
      expected: { kind: "ask", artifactId: "post-2" },
    },
    {
      command: { kind: "create", count: 2 },
      instruction: "Review the current post",
      expected: { kind: "create_post", delivery: "atomic" },
    },
    {
      command: { kind: "edit", targetPostId: "post-2", scope: "full_post" },
      instruction: "Tell me what you think",
      expected: {
        kind: "edit_artifact",
        artifactId: "post-2",
        instruction: "Tell me what you think",
        editMode: "general",
      },
    },
    {
      command: { kind: "edit", targetPostId: "post-2", scope: "hook" },
      instruction: "Make it sharper",
      expected: {
        kind: "edit_artifact",
        artifactId: "post-2",
        instruction: "Make it sharper",
        editMode: "hook_only",
      },
    },
  ])("maps $command.kind without interpreting instruction wording", ({
    command,
    instruction,
    expected,
  }) => {
    expect(commandToTurnOperation(command, instruction)).toEqual(expected);
  });

  test("the chat transport carries one typed command", () => {
    expect(
      chatTurnRequestSchema.parse({
        message: "Review the current post",
        command: { kind: "create", count: 2 },
      }).command,
    ).toEqual({ kind: "create", count: 2 });
  });

  test("the transport rejects competing command authorities", () => {
    expect(
      chatTurnRequestSchema.safeParse({
        message: "Anything",
        command: { kind: "ask" },
        operation: { kind: "create_post" },
      }).success,
    ).toBe(false);
  });

  test("composer selection creates one complete command and ignores irrelevant controls", () => {
    expect(
      commandForComposer({
        kind: "ask",
        count: 6,
        contextPostId: "post-2",
      }),
    ).toEqual({ kind: "ask", contextPostId: "post-2" });
    expect(
      commandForComposer({ kind: "create", count: 2, contextPostId: "post-2" }),
    ).toEqual({ kind: "create", count: 2 });
    expect(
      commandForComposer({
        kind: "edit",
        count: 6,
        targetPostId: "post-2",
        scope: "hook",
      }),
    ).toEqual({ kind: "edit", targetPostId: "post-2", scope: "hook" });
  });

  test("composer Edit fails closed without a selected Post", () => {
    expect(() =>
      commandForComposer({ kind: "edit", count: 1, scope: "full_post" }),
    ).toThrow("Edit requires a selected Post");
  });

  test("an empty pending-answer selection resumes persisted authority", () => {
    expect(resumesPersistedCoworkOperation({ actionSelectionIds: [] })).toBe(true);
  });

  test("distinguishes ordinary turns from Retry and selected pending answers", () => {
    expect(resumesPersistedCoworkOperation({})).toBe(false);
    expect(
      resumesPersistedCoworkOperation({ retryOfUserMessageId: "user-1" }),
    ).toBe(true);
    expect(
      resumesPersistedCoworkOperation({ actionSelectionIds: ["draft-1"] }),
    ).toBe(true);
  });
});
