import { describe, expect, test, vi } from "vitest";
import {
  resolveActionRetryRoot,
  type ActionRetryRepository,
} from "@/lib/agent/action-retry";
import {
  chatTurnRequestSchema,
  creatorStyleSelectionMarkerFromToolCalls,
  modeledDraftBatchContinuationMarkerFromToolCalls,
  retryRootMarkerFromToolCalls,
} from "@/lib/agent/chat-turn";
import { continuationForModeledDraftRoute } from "@/lib/agent/modeled-draft-continuation";

function repository(
  overrides: Partial<ActionRetryRepository> = {},
): ActionRetryRepository {
  const route = {
    kind: "action_management" as const,
    targetCount: 1,
    requirements: [{ type: "move_on_board" as const, status: "ready" as const }],
  };
  return {
    latestUser: vi.fn(async () => ({
      id: "retry-user",
      content: "Move the pricing draft to ready.",
    })),
    userById: vi.fn(async ({ userMessageId }) => ({
      id: userMessageId,
      content: "Move the pricing draft to ready.",
    })),
    contextForUser: vi.fn(async () => ({
      rootTurnMessageId: "original-user",
      effectiveInstruction: "Move the pricing draft to ready.",
      route,
      confirmedTargetIds: [],
      cancelled: false,
    })),
    latestContext: vi.fn(async () => null),
    saveContext: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("action retry lineage", () => {
  test("the stream contract accepts an explicit persisted retry user id", () => {
    expect(
      chatTurnRequestSchema.parse({
        message: "Move the pricing draft to ready.",
        retryOfUserMessageId: "retry-user",
      }),
    ).toMatchObject({ retryOfUserMessageId: "retry-user" });
  });

  test("reads retry ancestry only from the server-owned recoverable marker", () => {
    const root = "00000000-0000-4000-8000-000000000111";
    expect(
      retryRootMarkerFromToolCalls([
        {
          id: "_recoverable",
          type: "function",
          function: {
            name: "_recoverable",
            arguments: JSON.stringify({
              code: "modeled_batch_deadline",
              message: "Retry",
              retryRootUserMessageId: root,
            }),
          },
        },
      ]),
    ).toEqual({ kind: "valid", rootUserMessageId: root });

    expect(
      retryRootMarkerFromToolCalls([
        {
          id: "model-authored-call",
          type: "function",
          function: {
            name: "_recoverable",
            arguments: JSON.stringify({ retryRootUserMessageId: root }),
          },
        },
      ]),
    ).toEqual({ kind: "none" });
    expect(
      retryRootMarkerFromToolCalls([
        {
          id: "_recoverable",
          type: "function",
          function: {
            name: "_recoverable",
            arguments: JSON.stringify({
              retryRootUserMessageId: "not-a-uuid",
            }),
          },
        },
      ]),
    ).toEqual({ kind: "invalid" });
  });

  test("reads a typed modeled continuation only when it is bound to a server retry root", () => {
    const continuation = continuationForModeledDraftRoute({
      kind: "workspace_research",
      expectsDraft: true,
      expectedDrafts: 3,
      minimumSources: 3,
      workspaceSearchMode: "diverse",
      workspaceDraftSourceMode: "one_to_one",
    });
    const marker = {
      id: "_recoverable",
      type: "function" as const,
      function: {
        name: "_recoverable",
        arguments: JSON.stringify({
          code: "modeled_batch_resumable_reviewer_unavailable",
          message: "Retry",
          retryRootUserMessageId:
            "00000000-0000-4000-8000-000000000111",
          continuation,
        }),
      },
    };

    expect(modeledDraftBatchContinuationMarkerFromToolCalls([marker])).toEqual({
      kind: "valid",
      continuation,
    });
    expect(
      modeledDraftBatchContinuationMarkerFromToolCalls([
        {
          ...marker,
          function: {
            ...marker.function,
            arguments: JSON.stringify({ continuation }),
          },
        },
      ]),
    ).toEqual({ kind: "invalid" });
    expect(
      modeledDraftBatchContinuationMarkerFromToolCalls([
        {
          ...marker,
          function: {
            ...marker.function,
            arguments: JSON.stringify({
              code: "modeled_batch_resumable_reviewer_unavailable",
              retryRootUserMessageId:
                "00000000-0000-4000-8000-000000000111",
              continuation: { ...continuation, version: 2 },
            }),
          },
        },
      ]),
    ).toEqual({ kind: "invalid" });
  });

  test("recovers creator style only from one valid server-owned user marker", () => {
    const id = "00000000-0000-4000-8000-000000000402";
    const valid = {
      id: "_creator_style_selected",
      type: "function" as const,
      function: {
        name: "_creator_style_selected",
        arguments: JSON.stringify({
          id,
          name: "Evidence-led cadence",
          creatorName: "Fixture Creator",
          retryContext: {
            version: 1,
            resolvedBlock: "Frozen creator-style block",
          },
        }),
      },
    };

    expect(creatorStyleSelectionMarkerFromToolCalls([valid])).toEqual({
      kind: "valid",
      context: {
        version: 1,
        id,
        name: "Evidence-led cadence",
        creatorName: "Fixture Creator",
        resolvedBlock: "Frozen creator-style block",
      },
    });
    expect(
      creatorStyleSelectionMarkerFromToolCalls([
        {
          ...valid,
          function: {
            ...valid.function,
            arguments: JSON.stringify({
              id,
              name: "Evidence-led cadence",
              creatorName: "Fixture Creator",
            }),
          },
        },
      ]),
    ).toEqual({ kind: "unfrozen", id });
    expect(
      creatorStyleSelectionMarkerFromToolCalls([
        {
          ...valid,
          id: "model-authored-call",
        },
      ]),
    ).toEqual({ kind: "none" });
    expect(
      creatorStyleSelectionMarkerFromToolCalls([
        {
          ...valid,
          function: { ...valid.function, arguments: "{not json" },
        },
      ]),
    ).toEqual({ kind: "invalid" });
    expect(creatorStyleSelectionMarkerFromToolCalls([valid, valid])).toEqual({
      kind: "invalid",
    });
  });

  test("resolves a repeated UI Retry to the newest same-task checkpoint root", async () => {
    await expect(
      resolveActionRetryRoot(
        {
          workspaceId: "ws-1",
          chatId: "chat-1",
          retryOfUserMessageId: "retry-user",
          submittedContent: "Move the pricing draft to ready.",
        },
        repository(),
      ),
    ).resolves.toEqual({
      ok: true,
      turnMessageId: "original-user",
      effectiveInstruction: "Move the pricing draft to ready.",
      route: {
        kind: "action_management",
        targetCount: 1,
        requirements: [{ type: "move_on_board", status: "ready" }],
      },
      confirmedTargetIds: [],
    });
  });

  test("rejects Retry for a durably cancelled action root", async () => {
    await expect(
      resolveActionRetryRoot(
        {
          workspaceId: "ws-1",
          chatId: "chat-1",
          retryOfUserMessageId: "retry-user",
          submittedContent: "Move the pricing draft to ready.",
        },
        repository({
          contextForUser: vi.fn(async () => ({
            rootTurnMessageId: "original-user",
            effectiveInstruction: "Move the pricing draft to ready.",
            route: {
              kind: "action_management" as const,
              targetCount: 1,
              requirements: [
                {
                  type: "move_on_board" as const,
                  status: "ready" as const,
                },
              ],
            },
            confirmedTargetIds: [],
            cancelled: true,
          })),
        }),
      ),
    ).resolves.toEqual({ ok: false, reason: "cancelled" });
  });

  test("rejects Retry for an explicitly stopped turn without an action context", async () => {
    await expect(
      resolveActionRetryRoot(
        {
          workspaceId: "ws-1",
          chatId: "chat-1",
          retryOfUserMessageId: "retry-user",
          submittedContent: "Move the pricing draft to ready.",
          pairedUserStopped: true,
          pairedAssistantRecoverable: true,
        },
        repository({ contextForUser: vi.fn(async () => null) }),
      ),
    ).resolves.toEqual({ ok: false, reason: "cancelled" });
  });

  test("rejects Retry when the exact persisted turn already completed", async () => {
    await expect(
      resolveActionRetryRoot(
        {
          workspaceId: "ws-1",
          chatId: "chat-1",
          retryOfUserMessageId: "retry-user",
          submittedContent: "Move the pricing draft to ready.",
          pairedAssistantTerminalReason: "done",
        },
        repository(),
      ),
    ).resolves.toEqual({ ok: false, reason: "completed" });
  });

  test("allows a persisted done outcome when its exact recovery marker offers Retry", async () => {
    await expect(
      resolveActionRetryRoot(
        {
          workspaceId: "ws-1",
          chatId: "chat-1",
          retryOfUserMessageId: "retry-user",
          submittedContent: "Move the pricing draft to ready.",
          pairedAssistantTerminalReason: "done",
          pairedAssistantRecoverable: true,
        },
        repository(),
      ),
    ).resolves.toMatchObject({
      ok: true,
      turnMessageId: "original-user",
    });
  });

  test("rejects a stale retry button or altered task before a new turn is claimed", async () => {
    await expect(
      resolveActionRetryRoot(
        {
          workspaceId: "ws-1",
          chatId: "chat-1",
          retryOfUserMessageId: "older-user",
          submittedContent: "Move another draft to ready.",
        },
        repository(),
      ),
    ).resolves.toEqual({ ok: false, reason: "stale_or_altered" });
  });

  test("uses the referenced turn when no explicit retry context exists yet", async () => {
    await expect(
      resolveActionRetryRoot(
        {
          workspaceId: "ws-1",
          chatId: "chat-1",
          retryOfUserMessageId: "retry-user",
          submittedContent: "Move the pricing draft to ready.",
        },
        repository({ contextForUser: vi.fn(async () => null) }),
      ),
    ).resolves.toEqual({
      ok: true,
      turnMessageId: "retry-user",
      effectiveInstruction: "Move the pricing draft to ready.",
      route: null,
      confirmedTargetIds: [],
    });
  });

  test("keeps the original retry root across a chained recoverable Retry", async () => {
    const retryRepository = repository({
      latestUser: vi.fn(async () => ({
        id: "second-retry-user",
        content: "Find 3 regular posts and model each one in my voice.",
      })),
      contextForUser: vi.fn(async () => null),
    });
    retryRepository.userById = vi.fn(async () => ({
      id: "original-user",
      content: "Find 3 regular posts and model each one in my voice.",
    }));

    await expect(
      resolveActionRetryRoot(
        {
          workspaceId: "ws-1",
          chatId: "chat-1",
          retryOfUserMessageId: "second-retry-user",
          submittedContent:
            "Find 3 regular posts and model each one in my voice.",
          pairedAssistantRecoverable: true,
          pairedAssistantRetryRootUserMessageId: "original-user",
        },
        retryRepository,
      ),
    ).resolves.toMatchObject({
      ok: true,
      turnMessageId: "original-user",
    });
  });

  test("rejects a chained Retry whose persisted root cannot be resolved", async () => {
    await expect(
      resolveActionRetryRoot(
        {
          workspaceId: "ws-1",
          chatId: "chat-1",
          retryOfUserMessageId: "retry-user",
          submittedContent: "Move the pricing draft to ready.",
          pairedAssistantRecoverable: true,
          pairedAssistantRetryRootUserMessageId:
            "00000000-0000-4000-8000-000000000222",
        },
        repository({
          contextForUser: vi.fn(async () => null),
          userById: vi.fn(async () => null),
        }),
      ),
    ).resolves.toEqual({ ok: false, reason: "stale_or_altered" });
  });

  test("does not consult unrelated latest context when the referenced turn has no retry context", async () => {
    const contextForUser = vi.fn(async () => null);
    const latestContext = vi.fn(async () => ({
      rootTurnMessageId: "unrelated-identical-user",
      effectiveInstruction: "Move the pricing draft to ready.",
      route: {
        kind: "action_management" as const,
        targetCount: 1,
        requirements: [
          { type: "move_on_board" as const, status: "ready" as const },
        ],
      },
      confirmedTargetIds: [],
      cancelled: false,
    }));
    await expect(
      resolveActionRetryRoot(
        {
          workspaceId: "ws-1",
          chatId: "chat-1",
          retryOfUserMessageId: "retry-user",
          submittedContent: "Move the pricing draft to ready.",
        },
        repository({ contextForUser, latestContext }),
      ),
    ).resolves.toEqual({
      ok: true,
      turnMessageId: "retry-user",
      effectiveInstruction: "Move the pricing draft to ready.",
      route: null,
      confirmedTargetIds: [],
    });
    expect(contextForUser).toHaveBeenCalledWith(
      expect.objectContaining({ userMessageId: "retry-user" }),
    );
    expect(latestContext).not.toHaveBeenCalled();
  });

  test("restores the expanded action instruction for a Retry after clarification", async () => {
    await expect(
      resolveActionRetryRoot(
        {
          workspaceId: "ws-1",
          chatId: "chat-1",
          retryOfUserMessageId: "retry-user",
          submittedContent: "Tomorrow",
        },
        repository({
          latestUser: vi.fn(async () => ({ id: "retry-user", content: "Tomorrow" })),
          contextForUser: vi.fn(async () => ({
            rootTurnMessageId: "clarification-answer-user",
            effectiveInstruction:
              "Schedule the hiring draft.\n\nClarification answer: Tomorrow",
            route: {
              kind: "action_management" as const,
              targetCount: 1,
              requirements: [
                { type: "schedule_post" as const, date: "2026-07-15" },
              ],
            },
            confirmedTargetIds: [],
            cancelled: false,
          })),
        }),
      ),
    ).resolves.toEqual({
      ok: true,
      turnMessageId: "clarification-answer-user",
      effectiveInstruction:
        "Schedule the hiring draft.\n\nClarification answer: Tomorrow",
      route: {
        kind: "action_management",
        targetCount: 1,
        requirements: [{ type: "schedule_post", date: "2026-07-15" }],
      },
      confirmedTargetIds: [],
    });
  });
});
