import { describe, expect, test } from "vitest";
import {
  continuationForModeledDraftRoute,
  parseModeledDraftBatchContinuation,
} from "@/lib/agent/modeled-draft-continuation";

describe("modeled draft batch continuation", () => {
  test("round-trips only the frozen one-to-one route contract", () => {
    const continuation = continuationForModeledDraftRoute({
      kind: "workspace_research",
      expectsDraft: true,
      expectedDrafts: 4,
      minimumSources: 4,
      workspaceSearchMode: "strict_top",
      workspaceSince: "30d",
      workspacePostType: "regular",
      workspaceDraftSourceMode: "one_to_one",
    });

    expect(parseModeledDraftBatchContinuation(continuation)).toEqual(
      continuation,
    );
    expect(continuation).toMatchObject({
      kind: "modeled_draft_batch",
      version: 1,
      route: {
        expectedDrafts: 4,
        minimumSources: 4,
        workspaceDraftSourceMode: "one_to_one",
      },
    });
  });

  test("preserves a larger frozen discovery pool after explicit narrowing", () => {
    expect(
      continuationForModeledDraftRoute({
        kind: "workspace_research",
        expectsDraft: true,
        expectedDrafts: 2,
        minimumSources: 4,
        workspaceSearchMode: "strict_top",
        workspaceDraftSourceMode: "one_to_one",
      }),
    ).toMatchObject({
      route: { expectedDrafts: 2, minimumSources: 4 },
    });
  });

  test.each([
    {
      kind: "workspace_research",
      expectsDraft: true,
      expectedDrafts: 1,
      minimumSources: 1,
      workspaceSearchMode: "diverse",
      workspaceDraftSourceMode: "one_to_one",
    },
    {
      kind: "workspace_research",
      expectsDraft: true,
      expectedDrafts: 4,
      minimumSources: 3,
      workspaceSearchMode: "diverse",
      workspaceDraftSourceMode: "one_to_one",
    },
    {
      kind: "web_research",
      expectsDraft: true,
      expectedDrafts: 4,
      minimumSources: 4,
      workspaceSearchMode: "diverse",
      workspaceDraftSourceMode: "one_to_one",
    },
  ] as const)("does not mint a continuation for a non-batch route", (route) => {
    expect(continuationForModeledDraftRoute(route)).toBeNull();
  });

  test("rejects marker extensions and malformed route values", () => {
    const valid = continuationForModeledDraftRoute({
      kind: "workspace_research",
      expectsDraft: true,
      expectedDrafts: 3,
      minimumSources: 3,
      workspaceSearchMode: "diverse",
      workspaceDraftSourceMode: "one_to_one",
    });
    expect(valid).not.toBeNull();

    expect(
      parseModeledDraftBatchContinuation({ ...valid, elevated: true }),
    ).toBeNull();
    expect(
      parseModeledDraftBatchContinuation({
        ...valid,
        route: { ...valid?.route, workspaceSince: "forever" },
      }),
    ).toBeNull();
  });
});
