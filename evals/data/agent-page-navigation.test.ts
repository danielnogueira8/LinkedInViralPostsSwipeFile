import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const source = (path: string) => readFileSync(path, "utf8");

const PAGE = "app/(app)/dashboard/agent/page.tsx";
const COWORK_PAGE = "app/(app)/dashboard/page.tsx";
const NAV = "app/(app)/dashboard/nav-destinations.ts";
const WORKSPACE = "app/(app)/dashboard/chat-workspace.tsx";
const INBOX = "app/(app)/dashboard/agent-inbox.tsx";
const NAV_BADGES = "app/(app)/dashboard/nav-badges.ts";
const INBOX_ROUTE = "app/api/agent/inbox/route.ts";
const IDEA_ROUTE = "app/api/agent/inbox/ideas/[id]/route.ts";

describe("Your Agent is a top-level dashboard page", () => {
  test("the Create navigation puts Your Agent immediately above Cowork", () => {
    const nav = source(NAV);
    const agent = nav.indexOf('href: "/dashboard/agent"');
    const cowork = nav.indexOf('href: "/dashboard"');

    expect(agent).toBeGreaterThan(-1);
    expect(cowork).toBeGreaterThan(agent);
    expect(nav.slice(agent, cowork)).toContain('label: "Your Agent"');
  });

  test("the dedicated route renders the opportunity inbox with a page heading", () => {
    const page = source(PAGE);
    expect(page).toContain("export default function AgentPage");
    expect(page).toContain('title="Agent Inbox"');
    expect(page).toContain("<AgentInbox");
  });

  test("the Agent page keeps Cowork's new-session action out of its header", () => {
    const page = source(PAGE);
    const coworkPage = source(COWORK_PAGE);
    expect(page).not.toContain('href="/dashboard?new=1"');
    expect(page).not.toContain("New session");
    expect(coworkPage).toContain('newSession === "1"');
    expect(source(WORKSPACE)).toContain('url.searchParams.delete("new")');
  });

  test("the top-level navigation preserves the Agent attention badge", () => {
    const badges = source(NAV_BADGES);
    expect(badges).toContain("loadAgentInbox()");
    expect(source(INBOX)).toContain("loadAgentInbox({ replenish: true })");
    expect(badges).toContain('next["/dashboard/agent"] = count');
    expect(source(INBOX)).toContain("Open in Cowork");
    expect(source(INBOX)).toContain('body: JSON.stringify({ kind: next })');
  });

  test("an Agent handoff opens the new Cowork session in Create mode", () => {
    const workspace = source(WORKSPACE);
    const handoffStart = workspace.indexOf("// Agent inbox handoff.");
    const handoffEnd = workspace.indexOf(
      "// (The Posts \"Model in Chat\" handoff",
      handoffStart,
    );
    const handoff = workspace.slice(handoffStart, handoffEnd);

    expect(workspace).toContain('agentIdeaParam\n      ? { kind: "create" }');
    expect(handoff).toContain("enterCreateCommand(1)");
    expect(handoff).not.toContain('setCoworkComposer({ kind: "ask" })');
  });

  test("Cowork no longer owns an embedded agent destination", () => {
    const workspace = source(WORKSPACE);
    expect(workspace).not.toContain("AgentPinnedRow");
    expect(workspace).not.toContain("AgentView");
    expect(workspace).not.toContain("agentViewOpen");
    expect(workspace).not.toContain("cowork-destination");
    expect(workspace).not.toContain("<AgentBriefing");
  });
});

describe("the standalone Agent page exposes the daily opportunity workflow", () => {
  test("the standalone page exposes a unified approval queue", () => {
    const page = source(PAGE);
    const inbox = source(INBOX);
    expect(page).toContain('PageShell width="full"');
    expect(inbox).toContain('aria-label="Filter opportunities by agent"');
    expect(inbox).toContain("aria-pressed");
    expect(inbox).toContain("Today&apos;s inbox");
    expect(inbox).toContain(">Today&apos;s recommendations</h3>");
    expect(inbox).toContain("grid-cols-[minmax(17rem,0.82fr)_minmax(0,1.18fr)]");
    expect(inbox).toContain("selectedFilter");
    expect(inbox).not.toContain("snap-mandatory");
    // The queue keeps a compact source count and the detail drawer owns the
    // full dossier; long card copy is visually capped at two lines.
    expect(inbox).toContain("idea.evidence.length");
    expect(inbox).toContain("line-clamp-2");
    expect(inbox).toContain("LaneAvatar");
    expect(inbox).not.toContain("idea.evidence.slice(0, 2)");
    expect(inbox).toContain("selectedIdea");
    expect(inbox).not.toContain("displayedIdeas[0]");
    expect(inbox).toContain("border-l-foreground/60");
    expect(inbox).toContain("ring-foreground/15");
    expect(inbox).toContain("focus-visible:ring-2 focus-visible:ring-foreground/35");
    expect(inbox).not.toContain("border-l-violet-500");
    expect(inbox).toContain('label: "Opened"');
    expect(inbox).toContain("Open in Cowork");
    expect(inbox).toContain("Unread");
    expect(inbox).toContain("Done");
    expect(source(IDEA_ROUTE)).toContain('z.literal("done")');
    expect(inbox).toContain("Discard");
    expect(inbox).not.toContain("Not today");
    expect(inbox).not.toContain("Clock3");
    expect(inbox).toContain("New ideas arrive every day");
  });

  test("the inbox read path can recover a missed daily delivery", () => {
    const route = source(INBOX_ROUTE);
    expect(route).toContain("inbox.replenish");
    expect(route).toContain("preferences.timezone");
    expect(route).toContain('searchParams.get("replenish") === "1"');
    expect(route).toContain("isDueNow");
  });
});
