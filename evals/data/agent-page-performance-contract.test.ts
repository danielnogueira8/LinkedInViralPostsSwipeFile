import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const read = (file: string) =>
  fs.readFileSync(path.join(ROOT, file), "utf8");

describe("Your Agent page performance contracts", () => {
  test("the page and navigation badge share one in-flight briefing request", () => {
    const briefing = read("app/(app)/dashboard/agent-briefing.tsx");
    const badges = read("app/(app)/dashboard/nav-badges.ts");
    const client = read("app/(app)/dashboard/agent-briefing-client.ts");

    expect(briefing).toContain("loadAgentBriefing()");
    expect(badges).toContain("loadAgentBriefing()");
    expect(client).toContain('fetch("/api/agent/briefing"');
    expect(client).toContain("pendingBriefingPromise ??=");
    expect(briefing).not.toContain('fetch("/api/agent/briefing"');
    expect(badges).not.toContain('fetch("/api/agent/briefing"');
  });

  test("week-plan source cards and posting-gap reads finish in parallel", () => {
    const route = read("app/api/agent/week-plan/route.ts");
    const parallelBlock =
      route.match(
        /Promise\.all\(\[\s*attachSourcePosts\([\s\S]*?postingGap\([\s\S]*?\]\)/,
      )?.[0] ?? "";

    expect(parallelBlock).toContain("attachSourcePosts");
    expect(parallelBlock).toContain("postingGap");
  });
});
