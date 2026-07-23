import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const source = (path: string) => readFileSync(path, "utf8");

const PAGE = "app/(app)/dashboard/agent/page.tsx";
const COWORK_PAGE = "app/(app)/dashboard/page.tsx";
const NAV = "app/(app)/dashboard/nav-destinations.ts";
const WORKSPACE = "app/(app)/dashboard/chat-workspace.tsx";
const BRIEFING = "app/(app)/dashboard/agent-briefing.tsx";
const NAV_BADGES = "app/(app)/dashboard/nav-badges.ts";
const DRAFTS_LIST = "app/(app)/dashboard/posts/drafts-list.tsx";

describe("Your Agent is a top-level dashboard page", () => {
  test("the Create navigation puts Your Agent immediately above Cowork", () => {
    const nav = source(NAV);
    const agent = nav.indexOf('href: "/dashboard/agent"');
    const cowork = nav.indexOf('href: "/dashboard"');

    expect(agent).toBeGreaterThan(-1);
    expect(cowork).toBeGreaterThan(agent);
    expect(nav.slice(agent, cowork)).toContain('label: "Your Agent"');
  });

  test("the dedicated route renders the briefing with a page heading", () => {
    const page = source(PAGE);
    expect(page).toContain("export default function AgentPage");
    expect(page).toContain('title="Your Agent"');
    expect(page).toContain("<AgentBriefing");
  });

  test("the moved surface preserves a direct new-session action", () => {
    const page = source(PAGE);
    const coworkPage = source(COWORK_PAGE);
    expect(page).toContain('href="/dashboard?new=1"');
    expect(page).toContain("New session");
    expect(coworkPage).toContain('newSession === "1"');
    expect(source(WORKSPACE)).toContain('url.searchParams.delete("new")');
  });

  test("the top-level navigation preserves the Agent attention badge", () => {
    const badges = source(NAV_BADGES);
    expect(badges).toContain('fetch("/api/agent/briefing"');
    expect(badges).toContain('next["/dashboard/agent"] = count');
    expect(source(BRIEFING)).toContain("invalidateNavBadges()");
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

describe("the standalone Agent page preserves briefing behavior", () => {
  test("Review marks the draft reviewed and deep-links to the Posts board", () => {
    const briefing = source(BRIEFING);
    const drafts = source(DRAFTS_LIST);
    expect(briefing).toContain("/api/agent/briefing/reviewed");
    expect(briefing).toContain("/dashboard/posts?open=");
    expect(drafts).toContain('searchParams.get("open")');
    expect(drafts).toContain("openedDeepLinkRef");
  });

  test("the wide page keeps the seven-day row and responsive detail layout", () => {
    const page = source(PAGE);
    const briefing = source(BRIEFING);
    expect(page).toContain('PageShell width="full"');
    expect(briefing).toContain("lg:grid-cols-7");
    expect(briefing).toContain("lg:grid-cols-2");
  });
});
