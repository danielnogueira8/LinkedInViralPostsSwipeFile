import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const source = (path: string) => readFileSync(path, "utf8");

const draftsList = source("app/(app)/dashboard/posts/drafts-list.tsx");
const outcomes = source("app/(app)/dashboard/post-outcomes.tsx");
const creatorStyles = source("app/(app)/dashboard/creator-styles/manager.tsx");

describe("dashboard authoring review regression contracts", () => {
  test("mobile board follows the edited draft's committed column after async metadata changes", () => {
    expect(draftsList).toContain("const editingColumnRef");
    expect(draftsList).toMatch(
      /previousColumn !== null\s*&&\s*currentColumn !== null\s*&&\s*previousColumn !== currentColumn/,
    );
  });

  test("outcome load failures are not presented as an empty successful list", () => {
    expect(outcomes).toMatch(
      /if \(!response\.ok\)\s*\{\s*throw new Error\(response\.error \|\| "Couldn't load business outcomes\."\);/,
    );
  });

  test("creator-style refresh failures enter the bounded polling failure path", () => {
    expect(creatorStyles).toMatch(
      /if \(!data\?\.ok \|\| !Array\.isArray\(data\.styles\)\)\s*\{\s*throw new Error/,
    );
  });

  test("creator-style card keyboard activation ignores nested controls", () => {
    expect(creatorStyles).toContain("if (e.target !== e.currentTarget) return;");
  });
});
