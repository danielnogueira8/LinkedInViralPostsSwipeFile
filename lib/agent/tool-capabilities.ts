import type { ActionCheckpoint } from "@/lib/agent/action-checkpoints";

/**
 * Tool effects used at trust boundaries such as outcome authorization and
 * telemetry. Keep the classification beside the tool vocabulary so a new
 * mutating tool has one canonical place to declare its authority.
 */
const BOARD_MUTATION_EFFECTS = {
  move_on_board: "board_mutation",
  schedule_post: "board_mutation",
} as const satisfies Record<
  ActionCheckpoint["actionType"],
  "board_mutation"
>;

export const BOARD_MUTATION_TOOL_NAMES = Object.keys(
  BOARD_MUTATION_EFFECTS,
) as Array<keyof typeof BOARD_MUTATION_EFFECTS>;

export type BoardMutationToolName =
  (typeof BOARD_MUTATION_TOOL_NAMES)[number];

const BOARD_MUTATION_TOOLS: ReadonlySet<string> = new Set(
  BOARD_MUTATION_TOOL_NAMES,
);

export function isBoardMutationToolName(
  name: string,
): name is BoardMutationToolName {
  return BOARD_MUTATION_TOOLS.has(name);
}
