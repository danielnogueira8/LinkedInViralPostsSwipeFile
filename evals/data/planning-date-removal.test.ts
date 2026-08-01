import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";

const postsBoard = fs.readFileSync(
  path.join(process.cwd(), "app/(app)/dashboard/posts/drafts-list.tsx"),
  "utf8",
);
const editor = fs.readFileSync(
  path.join(process.cwd(), "app/(app)/dashboard/draft-editor-modal.tsx"),
  "utf8",
);
const agentTools = fs.readFileSync(
  path.join(process.cwd(), "lib/agent/tools.ts"),
  "utf8",
);

describe("planning-date removal", () => {
  test("removes planning-only controls and labels from the Posts UI", () => {
    expect(postsBoard).not.toContain("swipein:posts-view");
    expect(postsBoard).not.toContain("Planning date only");
    expect(editor).not.toContain('label="Planning date"');
    expect(editor).not.toContain('aria-label="Planning date"');
  });

  test("keeps the real LinkedIn scheduling controls and scheduled timestamps", () => {
    expect(editor).toContain("Schedule on LinkedIn");
    expect(editor).toContain('aria-label="Publish date and time"');
    expect(postsBoard).toContain("scheduledDate");
  });

  test("does not send a planning-only date when a new draft is created", () => {
    const createStart = editor.indexOf("await draftOperations.create({");
    const createEnd = editor.indexOf("});", createStart);
    expect(createStart).toBeGreaterThan(-1);
    expect(editor.slice(createStart, createEnd)).not.toContain("plan_to_post_on");
  });

  test("does not advertise the retired planning-only mutation to Cowork", () => {
    const definitionsStart = agentTools.indexOf("export const TOOL_DEFS");
    const definitionsEnd = agentTools.indexOf(
      "// -----------------------------------------------------------------------",
      definitionsStart,
    );
    expect(definitionsStart).toBeGreaterThan(-1);
    expect(definitionsEnd).toBeGreaterThan(definitionsStart);
    expect(
      agentTools.slice(definitionsStart, definitionsEnd),
    ).not.toContain('name: "schedule_post"');
  });
});
