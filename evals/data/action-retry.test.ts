import { describe, expect, test, vi } from "vitest";
import {
  resolveActionRetryRoot,
  type ActionRetryRepository,
} from "@/lib/agent/action-retry";
import { chatTurnRequestSchema } from "@/lib/agent/chat-turn";

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

  test("reconciles a persisted action context even after the rollout lane is disabled", async () => {
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
    ).resolves.toMatchObject({
      ok: true,
      turnMessageId: "original-user",
      route: { kind: "action_management" },
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

  test("does not infer retry ancestry from identical text elsewhere in the chat", async () => {
    const contextForUser = vi.fn(async () => null);
    await expect(
      resolveActionRetryRoot(
        {
          workspaceId: "ws-1",
          chatId: "chat-1",
          retryOfUserMessageId: "retry-user",
          submittedContent: "Move the pricing draft to ready.",
        },
        repository({ contextForUser }),
      ),
    ).resolves.toMatchObject({ turnMessageId: "retry-user" });
    expect(contextForUser).toHaveBeenCalledWith(
      expect.objectContaining({ userMessageId: "retry-user" }),
    );
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
