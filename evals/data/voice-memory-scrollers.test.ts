import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const read = (relativePath: string) =>
  fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");

const preferences = read("app/(app)/dashboard/voice/preferences.tsx");
const feedback = read("app/(app)/dashboard/voice/feedback-memory.tsx");
const list = read("app/(app)/dashboard/voice/memory-list.tsx");
const page = read("app/(app)/dashboard/voice/page.tsx");

describe("Voice memory panels", () => {
  test("give Memory Rules and Recent taste feedback their own bounded scrollers", () => {
    expect(preferences).toContain("<VoiceMemoryList");
    expect(feedback).toContain("<VoiceMemoryList");
    expect(list).toContain("max-h-80");
    expect(list).toContain("overflow-y-auto");
    expect(list).toContain("overscroll-contain");
    expect(list).toContain("[scrollbar-gutter:stable]");
    expect(list).toContain("tabIndex={0}");
    expect(list).toContain("aria-label={label}");
  });

  test("does not impose a storage cap on Memory Rules", () => {
    expect(preferences).not.toContain("PREFS_PER_WORKSPACE_MAX");
    expect(preferences).not.toContain("atCap");
    expect(page).not.toContain("PREFS_PER_WORKSPACE_MAX");
  });
});
