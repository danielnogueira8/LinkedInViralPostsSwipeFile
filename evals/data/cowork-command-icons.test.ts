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

  test("covers the composer and every expanded draft-card command", () => {
    expect(usageCount("ask")).toBe(2);
    expect(usageCount("create")).toBe(1);
    expect(usageCount("edit")).toBe(3);
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
