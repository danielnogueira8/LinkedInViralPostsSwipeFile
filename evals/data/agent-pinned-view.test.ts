import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// Contract tests for the "Your Agent" pinned-view redesign. These lock in the
// wiring that the redesign depends on so a future refactor can't silently
// regress it (there is no auth-free way to render these authed surfaces in a
// browser, so we assert on the source the way clipboard-call-sites.test.ts does).

const source = (path: string) => readFileSync(path, "utf8");

const BRIEFING_ROUTE = "app/api/agent/briefing/route.ts";
const REVIEWED_ROUTE = "app/api/agent/briefing/reviewed/route.ts";
const BRIEFING_COMPONENT = "app/(app)/dashboard/agent-briefing.tsx";
const WORKSPACE = "app/(app)/dashboard/chat-workspace.tsx";
const DRAFTS_LIST = "app/(app)/dashboard/posts/drafts-list.tsx";

describe("agent briefing — reviewed drafts drop off the list for good", () => {
  test("the GET briefing excludes drafts stamped meta.reviewed_at", () => {
    const file = source(BRIEFING_ROUTE);
    // The reviewed filter must be present so a reviewed draft stays gone across
    // reloads (the whole point of the persisted flag).
    expect(file).toContain('.is("meta->>reviewed_at", null)');
    // Still scoped to the workspace's own agent drafts.
    expect(file).toContain("AGENT_SUGGESTED_BY");
  });

  test("the reviewed endpoint stamps meta.reviewed_at, workspace + agent scoped", () => {
    const file = source(REVIEWED_ROUTE);
    expect(file).toContain("export async function POST");
    // Merges into existing meta (never clobbers suggested_by).
    expect(file).toContain("reviewed_at");
    expect(file).toContain('.eq("workspace_id", sb.workspaceId)');
    expect(file).toContain('.eq("meta->>suggested_by", AGENT_SUGGESTED_BY)');
  });
});

describe("Review opens the post on the board and marks it reviewed", () => {
  test("the briefing Review action calls the reviewed endpoint and deep-links", () => {
    const file = source(BRIEFING_COMPONENT);
    expect(file).toContain("/api/agent/briefing/reviewed");
    // Deep-links to the board with the post's id so it opens ON the post.
    expect(file).toContain("/dashboard/posts?open=");
  });

  test("the board opens ?open=<id> into the editor modal, once per id", () => {
    const file = source(DRAFTS_LIST);
    expect(file).toContain('searchParams.get("open")');
    // Guarded so it opens at most once and doesn't reopen after close/refresh.
    expect(file).toContain("openedDeepLinkRef");
    expect(file).toContain("setEditorOpen(true)");
  });
});

describe("the agent lives in a pinned Your Agent panel, not the empty state", () => {
  test("the briefing is reached only through the AgentView panel", () => {
    const file = source(WORKSPACE);
    expect(file).toContain("function AgentView");
    expect(file).toContain("function AgentPinnedRow");
    expect(file).toContain("agentViewOpen");
    // Exactly ONE JSX mount of AgentBriefing — inside AgentView, never on the
    // empty state (which used to render it inline and made the UI too big).
    const mounts = file.match(/<AgentBriefing\b/g) ?? [];
    expect(mounts.length).toBe(1);
    // And the empty state's slot for it is gone.
    expect(file).toContain(
      "The agent briefing moved to the pinned",
    );
  });

  test("opening a chat or starting a new one leaves the agent view", () => {
    const file = source(WORKSPACE);
    // Both entry points into a real conversation must close the panel.
    const loadChatCloses = /loadChat[\s\S]{0,400}setAgentViewOpen\(false\)/.test(
      file,
    );
    const newChatCloses = /newChat = useCallback[\s\S]{0,400}setAgentViewOpen\(false\)/.test(
      file,
    );
    expect(loadChatCloses).toBe(true);
    expect(newChatCloses).toBe(true);
  });
});
