import { describe, expect, test } from "vitest";
import { withoutBoardMutationTools } from "@/lib/agent";
import { TOOL_DEFS } from "@/lib/agent/tools";

describe("legacy agent board-mutation surface", () => {
  test("removes every unfenced board mutation when the action lane owns the workspace", () => {
    const names = withoutBoardMutationTools(TOOL_DEFS).map(
      (tool) => tool.function.name,
    );
    expect(names).toContain("list_drafts");
    expect(names).not.toContain("move_on_board");
    expect(names).not.toContain("schedule_post");
  });
});
