import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

describe("Your Agent page performance contracts", () => {
  test("the page and navigation badge share one in-flight inbox request", () => {
    const briefing = read("app/(app)/dashboard/agent-inbox.tsx");
    const badges = read("app/(app)/dashboard/nav-badges.ts");
    const client = read("app/(app)/dashboard/agent-inbox-client.ts");

    expect(briefing).toContain("loadAgentInbox()");
    expect(badges).toContain("loadAgentInbox()");
    expect(client).toContain('fetch("/api/agent/inbox"');
    expect(client).toContain("pendingAgentInboxPromise ??=");
    expect(briefing).not.toContain('fetch("/api/agent/inbox"');
    expect(badges).not.toContain('fetch("/api/agent/inbox"');
  });

  test("the posting-gap read overlaps the plan chain instead of trailing it", () => {
    const route = read("app/api/agent/week-plan/route.ts");
    // postingGap is hoisted: started right after scopedSupabase (overlapping
    // the load/compose/recover chain) and awaited in the tail Promise.all —
    // never a serial round trip at the end of the endpoint.
    const gapStart = route.indexOf("const gapNotePromise = postingGap(");
    const planChain = route.indexOf("loadStoredWeekPlan(sb.raw");
    const gapAwait = route.indexOf("gapNotePromise,");
    expect(gapStart).toBeGreaterThan(-1);
    expect(gapAwait).toBeGreaterThan(-1);
    expect(gapStart).toBeLessThan(planChain);
    expect(gapAwait).toBeGreaterThan(gapStart);
  });
});
