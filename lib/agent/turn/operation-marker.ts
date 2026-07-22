import type { ToolCall } from "@/lib/openrouter";

export const TURN_OPERATION_TOOL_NAME = "_turn_operation";
export const TURN_OPERATION_VERSION = 1;

/** Persist an already-validated operation using the one durable marker format. */
export function turnOperationToolCall(operation: object): ToolCall {
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
