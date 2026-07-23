import { z } from "zod";
import { draftCountSchema } from "@/lib/generation-config";
import type { ChatTurnOperation } from "@/lib/agent/turn/operation-marker";

export const coworkCommandSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ask"),
      contextPostId: z.string().min(1).max(200).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("create"),
      count: draftCountSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("edit"),
      targetPostId: z.string().min(1).max(200),
      scope: z.enum(["full_post", "hook"]),
    })
    .strict(),
]);

export type CoworkCommand = z.infer<typeof coworkCommandSchema>;
export type CoworkComposerCommandKind = "ask" | "create" | "edit";
export type CoworkComposerState =
  | { kind: "ask"; contextPostId?: string }
  | { kind: "create" }
  | {
      kind: "edit";
      targetPostId?: string;
      scope: "full_post" | "hook";
    };

export function initialCoworkComposerState(
  activeSessionId: string | null,
): CoworkComposerState {
  return activeSessionId ? { kind: "ask" } : { kind: "create" };
}

export function preservesCoworkCommandOnSessionChange(
  expectedSessionId: string | null | undefined,
  activeSessionId: string | null,
): boolean {
  return (
    expectedSessionId !== undefined && expectedSessionId === activeSessionId
  );
}

export function resumesPersistedCoworkOperation(input: {
  retryOfUserMessageId?: string;
  actionSelectionIds?: readonly string[];
  clarificationAssistantMessageId?: string;
}): boolean {
  return (
    Boolean(input.retryOfUserMessageId) ||
    input.actionSelectionIds !== undefined ||
    Boolean(input.clarificationAssistantMessageId)
  );
}

export function commandForComposer(input: {
  kind: CoworkComposerCommandKind;
  count: z.infer<typeof draftCountSchema>;
  contextPostId?: string;
  targetPostId?: string;
  scope?: "full_post" | "hook";
}): CoworkCommand {
  if (input.kind === "ask") {
    return {
      kind: "ask",
      ...(input.contextPostId ? { contextPostId: input.contextPostId } : {}),
    };
  }
  if (input.kind === "create") {
    return { kind: "create", count: input.count };
  }
  if (!input.targetPostId) {
    throw new Error("Edit requires a selected Post");
  }
  return {
    kind: "edit",
    targetPostId: input.targetPostId,
    scope: input.scope ?? "full_post",
  };
}

/**
 * Translate the product command into the existing durable turn marker without
 * inspecting the instruction. The command owns operation and identity; text is
 * content input only.
 */
export function commandToTurnOperation(
  command: CoworkCommand,
  instruction: string,
): ChatTurnOperation | null {
  if (command.kind === "ask") {
    return {
      kind: "ask",
      ...(command.contextPostId ? { artifactId: command.contextPostId } : {}),
    };
  }
  if (command.kind === "create") {
    return { kind: "create_post", delivery: "atomic" };
  }
  return {
    kind: "edit_artifact",
    artifactId: command.targetPostId,
    instruction,
    editMode: command.scope === "hook" ? "hook_only" : "general",
  };
}
