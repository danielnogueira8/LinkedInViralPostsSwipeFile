import { z } from "zod";
import type { ToolCall } from "@/lib/openrouter";

export const TURN_OPERATION_TOOL_NAME = "_turn_operation";
export const TURN_OPERATION_VERSION = 1;

export const chatTurnOperationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ask"),
      artifactId: z.string().min(1).max(200).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("create_post"),
      delivery: z.literal("atomic").optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("edit_artifact"),
      artifactId: z.string().min(1).max(200),
      instruction: z.string().trim().min(1).max(4_000),
      editMode: z.enum(["general", "hook_only"]).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("review_artifact"),
      artifactId: z.string().min(1).max(200).optional(),
    })
    .strict(),
]);

export type ChatTurnOperation = z.infer<typeof chatTurnOperationSchema>;

/** Persist an already-validated operation using the one durable marker format. */
export function turnOperationToolCall(operation: ChatTurnOperation): ToolCall {
  return {
    id: TURN_OPERATION_TOOL_NAME,
    type: "function",
    function: {
      name: TURN_OPERATION_TOOL_NAME,
      arguments: JSON.stringify({
        version: TURN_OPERATION_VERSION,
        ...operation,
      }),
    },
  };
}
