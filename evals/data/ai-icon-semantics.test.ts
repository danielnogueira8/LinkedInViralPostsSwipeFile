import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const AI_SURFACES = new Set([
  "app/(app)/dashboard/accounts/scrape-panel.tsx",
  "app/(app)/dashboard/chat-workspace.tsx",
  "app/(app)/dashboard/claude/page.tsx",
  "app/(app)/dashboard/draft-editor.tsx",
  "app/(app)/dashboard/first-run-checklist.tsx",
  "app/(app)/dashboard/lead-magnets/manager.tsx",
  "app/(app)/dashboard/voice/manager.tsx",
  "app/(app)/dashboard/voice/preferences.tsx",
  "app/(app)/dashboard/voice/voice-interview-card.tsx",
  "app/(marketing)/landing-client.tsx",
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [entryPath] : [];
  });
}

describe("AI icon semantics", () => {
  const root = process.cwd();
  const canonicalPath = path.join(root, "components/ai-icon.ts");
  const uiFiles = [
    ...sourceFiles(path.join(root, "app")),
    ...sourceFiles(path.join(root, "components")),
  ];

  it("uses Bot as the single canonical AI icon", () => {
    expect(readFileSync(canonicalPath, "utf8")).toContain(
      'export { Bot as AiIcon } from "lucide-react";',
    );
  });

  it("does not use star-like or direct bot icons in UI source", () => {
    const forbidden = /\b(?:BrainCircuit|Bot|Sparkle|Sparkles|Star|Stars|WandSparkles)\b/;
    const violations = uiFiles
      .filter((file) => file !== canonicalPath)
      .filter((file) => forbidden.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(root, file));

    expect(violations).toEqual([]);
  });

  it("limits the canonical AI icon to audited AI-driven surfaces", () => {
    const usages = uiFiles
      .filter((file) => file !== canonicalPath)
      .filter((file) => /\bAiIcon\b/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(root, file))
      .sort();

    expect(usages).toEqual([...AI_SURFACES].sort());
  });
});
