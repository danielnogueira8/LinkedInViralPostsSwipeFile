import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const read = (file: string) =>
  fs.readFileSync(path.join(ROOT, file), "utf8");

describe("Your Agent working-summary wiring", () => {
  test("loads a dedicated summary endpoint and renders it after modeled posts", () => {
    const briefing = read("app/(app)/dashboard/agent-briefing.tsx");
    const summary = read("app/(app)/dashboard/agent-working-summary.tsx");
    expect(summary).toContain('fetch("/api/agent/working-summary"');
    expect(summary).toContain("What&apos;s working for you");
    expect(summary).toContain("Voice baseline");
    expect(summary).toContain("Published performance");
    expect(summary).toContain("The topics earning attention");
    expect(summary).toContain("The formats carrying them");
    expect(summary).toContain("The hooks stopping the scroll");
    expect(summary).toContain("coerceStoredWorkingSummary(data.summary)");
    expect(briefing.lastIndexOf("<AgentWorkingSummary")).toBeGreaterThan(
      briefing.indexOf("Model recently viral posts"),
    );
  });

  test("the authenticated endpoint uses the shared persisted weekly analysis", () => {
    const route = read("app/api/agent/working-summary/route.ts");
    expect(route).toContain("scopedSupabase");
    expect(route).toContain("getUserWorkingSummary");
  });

  test("a resumable daily sweep keeps each analysis on a weekly TTL", () => {
    const route = read("app/api/cron/user-working-summaries/route.ts");
    const sweep = read(
      "lib/agent-loop/user-working-summary-cron.ts",
    );
    const vercel = read("vercel.json");
    expect(route).toContain("runWeeklyUserWorkingSummaries");
    expect(route).toContain("CRON_SECRET");
    expect(sweep).toContain("runWorkingSummarySweep");
    expect(sweep).toContain("saveCursor");
    expect(vercel).toContain("/api/cron/user-working-summaries");
  });
});
