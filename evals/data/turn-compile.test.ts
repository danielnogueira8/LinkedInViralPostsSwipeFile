import { describe, expect, test } from "vitest";
import type { ActionOrchestratorRoute } from "@/lib/agent/action-orchestrator-routing";
import type { ReadOnlyOrchestratorRoute } from "@/lib/agent/read-only-orchestrator-routing";
import {
  resolveTurnContract,
  resolveTurnCount,
} from "@/lib/agent/turn/compile";

describe("resolveTurnCount — the ONE turn count rule (1-6, UI > message > default)", () => {
  test("defaults to 1 when neither source provides a count", () => {
    expect(resolveTurnCount({})).toEqual({ count: 1, source: "default" });
    expect(resolveTurnCount({ uiDraftCount: null, messageCount: null })).toEqual({
      count: 1,
      source: "default",
    });
  });

  test("the UI override wins over the message count", () => {
    expect(
      resolveTurnCount({ uiDraftCount: 4, messageCount: 2 }),
    ).toEqual({ count: 4, source: "ui" });
  });

  test("the message count applies when the UI did not select one", () => {
    expect(resolveTurnCount({ messageCount: 3 })).toEqual({
      count: 3,
      source: "message",
    });
    expect(resolveTurnCount({ uiDraftCount: null, messageCount: 6 })).toEqual({
      count: 6,
      source: "message",
    });
  });

  test("accepts the full 1-6 range from either source", () => {
    for (const count of [1, 2, 3, 4, 5, 6] as const) {
      expect(resolveTurnCount({ uiDraftCount: count })).toEqual({
        count,
        source: "ui",
      });
      expect(resolveTurnCount({ messageCount: count })).toEqual({
        count,
        source: "message",
      });
    }
  });

  test("clamps valid integers into the range instead of dropping them", () => {
    expect(resolveTurnCount({ messageCount: 10 })).toEqual({
      count: 6,
      source: "message",
    });
    expect(resolveTurnCount({ uiDraftCount: 99 })).toEqual({
      count: 6,
      source: "ui",
    });
    expect(resolveTurnCount({ messageCount: 0 })).toEqual({
      count: 1,
      source: "message",
    });
    expect(resolveTurnCount({ messageCount: -3 })).toEqual({
      count: 1,
      source: "message",
    });
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, 2.5, "3" as unknown as number])(
    "ignores junk input %s and falls to the next source",
    (junk) => {
      expect(resolveTurnCount({ uiDraftCount: junk, messageCount: 2 })).toEqual({
        count: 2,
        source: "message",
      });
      expect(resolveTurnCount({ uiDraftCount: junk })).toEqual({
        count: 1,
        source: "default",
      });
      expect(resolveTurnCount({ messageCount: junk })).toEqual({
        count: 1,
        source: "default",
      });
    },
  );
});

describe("resolveTurnContract — the ONE turn contract (computed once, post-clarification)", () => {
  const actionRoute: ActionOrchestratorRoute = {
    kind: "action_management",
    targetCount: 3,
    requirements: [{ type: "move_on_board", status: "ready" }],
  };
  const draftRoute: ReadOnlyOrchestratorRoute = {
    kind: "news_research",
    expectsDraft: true,
    expectedDrafts: 5,
  };
  const researchRoute: ReadOnlyOrchestratorRoute = {
    kind: "web_research",
    expectsDraft: false,
  };

  test("the direct writer's task shapes the contract", () => {
    expect(
      resolveTurnContract({ directWriterTask: { kind: "multi", expectedCount: 4 } }),
    ).toEqual({ kind: "post", expectedCount: 4 });
    expect(
      resolveTurnContract({ directWriterTask: { kind: "partial" } }),
    ).toEqual({ kind: "partial", expectedCount: 1 });
    expect(
      resolveTurnContract({ directWriterTask: { kind: "original" } }),
    ).toEqual({ kind: "post", expectedCount: 1 });
  });

  test("a served action route wins over a read-only route", () => {
    expect(
      resolveTurnContract({
        actionRoute,
        useActionOrchestrator: true,
        readOnlyRoute: draftRoute,
        useReadOnlyOrchestrator: true,
      }),
    ).toEqual({ kind: "saved_draft_action", expectedCount: 3 });
  });

  test("a served read-only route wins over an unserved action route", () => {
    expect(
      resolveTurnContract({
        actionRoute,
        useActionOrchestrator: false,
        readOnlyRoute: draftRoute,
        useReadOnlyOrchestrator: true,
      }),
    ).toEqual({ kind: "post", expectedCount: 5 });
  });

  test("an unserved action route still beats an unserved read-only route", () => {
    expect(
      resolveTurnContract({ actionRoute, readOnlyRoute: draftRoute }),
    ).toEqual({ kind: "saved_draft_action", expectedCount: 3 });
  });

  test("non-management action routes contract zero committed actions", () => {
    expect(
      resolveTurnContract({
        actionRoute: { kind: "no_action", noActionReason: "negated" },
      }),
    ).toEqual({ kind: "saved_draft_action", expectedCount: 0 });
  });

  test("a research read-only route contracts research, not posts", () => {
    expect(resolveTurnContract({ readOnlyRoute: researchRoute })).toEqual({
      kind: "research",
      expectedCount: 1,
    });
  });

  test("legacy fallback: post count > partial spec > answer", () => {
    expect(
      resolveTurnContract({ fallbackPostCount: 3, hasPartialSpec: true }),
    ).toEqual({ kind: "post", expectedCount: 3 });
    expect(resolveTurnContract({ hasPartialSpec: true })).toEqual({
      kind: "partial",
      expectedCount: 1,
    });
    expect(resolveTurnContract({})).toEqual({
      kind: "answer",
      expectedCount: 1,
    });
    expect(
      resolveTurnContract({ fallbackPostCount: null, hasPartialSpec: false }),
    ).toEqual({ kind: "answer", expectedCount: 1 });
  });
});
