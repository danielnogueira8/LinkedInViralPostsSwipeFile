import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const workspace = readFileSync(
  "app/(app)/dashboard/chat-workspace.tsx",
  "utf8",
);

function usageCount(kind: "ask" | "create" | "edit"): number {
  return (
    workspace.match(
      new RegExp(`<CoworkCommandIcon kind="${kind}"`, "g"),
    ) ?? []
  ).length;
}

describe("Cowork command icons", () => {
  test("uses one canonical icon for each command", () => {
    expect(workspace).toContain("? MessageCircleQuestionMark");
    expect(workspace).toContain('? SquarePen');
    expect(workspace).toContain(': PenLine;');
  });

  test("covers the composer's command affordances", () => {
    // These counts are the COMPOSER's uses. The draft card's action bar
    // deliberately carries no command icons: it was five identically-weighted
    // outlined pills, and the fix was to give it a hierarchy — Schedule primary
    // (the only icon, as a single visual anchor), Save secondary, and
    // Copy/Ask/Edit as quiet text-only ghosts. Labels already say what they do;
    // an icon on each was noise competing with the primary action.
    expect(usageCount("ask")).toBe(1);
    expect(usageCount("create")).toBe(1);
    expect(usageCount("edit")).toBe(1);
  });

  test("the draft action bar has exactly one emphasised action", () => {
    // The hierarchy is the point: if a second button becomes `variant="default"`
    // the row goes back to competing for attention.
    const primaries =
      workspace.match(/variant=\{\s*\n?\s*scheduleStatus === "scheduled"/g) ?? [];
    expect(primaries).toHaveLength(1);
  });

  test("uses the Create icon for the original-post starter too", () => {
    expect(workspace).toMatch(
      /id: "write-original",[\s\S]*?command: "create",[\s\S]*?icon: SquarePen,/,
    );
  });

  test("does not leave the old Ask or Edit icons on command labels", () => {
    expect(workspace).not.toMatch(
      /<MessageSquare[^>]*\/>\s*(?:\{askContextPost|Ask\b)/,
    );
    expect(workspace).not.toMatch(/<Pencil[^>]*\/>\s*Edit\b/);
  });
});
