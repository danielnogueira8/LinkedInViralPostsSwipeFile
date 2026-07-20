import { afterEach, describe, expect, test, vi } from "vitest";
import { CHAT_MODEL } from "@/lib/openrouter";
import type { AgentEvent } from "@/lib/agent/contracts";
import type { ActionOrchestratorRoute } from "@/lib/agent/turn/compile";
import {
  FALLBACK_ACTION_ORCHESTRATOR_MODEL,
  PRIMARY_ACTION_ORCHESTRATOR_MODEL,
  actionDraftTitleQueries,
  actionOperationKey,
  assertPlanMatchesCheckpoints,
  candidateOptionLabels,
  parseActionPlan,
  runActionOrchestrator,
  type ActionCheckpoint,
  type ActionCheckpointRepository,
  type ActionDraft,
  type ActionOrchestratorAdapter,
  type ActionOrchestratorDependencies,
  type ActionOrchestratorInput,
  type ActionPlannerRequest,
  type MutationAction,
} from "@/lib/agent/action-orchestrator";
import { AdapterHealthRegistry } from "@/lib/agent/adapter-health";
import { createCoworkTurnTelemetry } from "@/lib/agent/cowork-telemetry";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const MOVE_ROUTE: ActionOrchestratorRoute = {
  kind: "action_management",
  targetCount: 1,
  requirements: [{ type: "move_on_board", status: "ready" }],
};

const DRAFT = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "SaaS pricing",
  kind: "post",
  status: "drafting",
  plan_to_post_on: null,
  created_at: "2026-07-14T10:00:00.000Z",
} satisfies ActionDraft;

const usage = (prompt: number, completion: number) => ({
  prompt_tokens: prompt,
  completion_tokens: completion,
  total_tokens: prompt + completion,
});

class ScriptedAdapter implements ActionOrchestratorAdapter {
  readonly requests: ActionPlannerRequest[] = [];

  constructor(
    readonly model: string,
    private readonly script: Array<
      | {
          toolArgs: Record<string, unknown> | null;
          usage?: ReturnType<typeof usage>;
          model?: string;
        }
      | Error
    >,
  ) {}

  async createPlan(request: ActionPlannerRequest) {
    this.requests.push(request);
    const next = this.script.shift();
    if (!next) throw new Error("planner script exhausted");
    if (next instanceof Error) throw next;
    return next;
  }
}

class MemoryCheckpoints implements ActionCheckpointRepository {
  readonly rows = new Map<string, ActionCheckpoint>();
  readonly claims: string[] = [];
  readonly finishes: string[] = [];
  readonly executions: string[] = [];
  failClaim = false;
  failClaimAt: number | null = null;
  failFinish = false;
  loseExecuteResponse = false;
  failExecuteBeforeCommit = false;
  executeFailureCode: string | null = null;
  listCalls = 0;
  readonly failListCalls = new Set<number>();
  beforeExecute: (() => void) | null = null;
  afterExecute: (() => void | Promise<void>) | null = null;
  failCancelAttempts = 0;
  failResetAttempts = 0;
  resetCalls = 0;
  readonly cancelledTurns = new Set<string>();
  cancelOnIsTurnCancelledCall: number | null = null;
  isTurnCancelledCalls = 0;
  readonly leasedOperations = new Set<string>();
  releaseCalls = 0;

  async listForTurn() {
    this.listCalls += 1;
    if (this.failListCalls.has(this.listCalls)) {
      throw new Error("checkpoint read unavailable");
    }
    return [...this.rows.values()];
  }

  async claim(input: Parameters<ActionCheckpointRepository["claim"]>[0]) {
    const attempt = this.claims.length + 1;
    if (this.failClaim || this.failClaimAt === attempt) {
      throw new Error("checkpoint unavailable");
    }
    this.claims.push(input.operationKey);
    const existing = this.rows.get(input.operationKey);
    if (this.cancelledTurns.has(input.turnMessageId)) {
      const checkpoint: ActionCheckpoint = existing ?? {
        id: `checkpoint-${this.rows.size + 1}`,
        workspaceId: input.workspaceId,
        chatId: input.chatId,
        turnMessageId: input.turnMessageId,
        operationKey: input.operationKey,
        actionType: input.actionType,
        targetId: input.targetId,
        arguments: input.arguments,
        status: "cancelled",
        result: { ok: false, cancelled: true },
        errorCode: "turn_cancelled",
      };
      this.rows.set(input.operationKey, checkpoint);
      return { checkpoint, owned: false, leaseToken: null };
    }
    if (existing && existing.status !== "running") {
      return { checkpoint: existing, owned: false, leaseToken: null };
    }
    if (existing && this.leasedOperations.has(input.operationKey)) {
      return { checkpoint: existing, owned: false, leaseToken: null };
    }
    const checkpoint: ActionCheckpoint = existing ?? {
      id: `checkpoint-${this.rows.size + 1}`,
      workspaceId: input.workspaceId,
      chatId: input.chatId,
      turnMessageId: input.turnMessageId,
      operationKey: input.operationKey,
      actionType: input.actionType,
      targetId: input.targetId,
      arguments: input.arguments,
      status: "running",
      result: null,
      errorCode: null,
    };
    this.rows.set(input.operationKey, checkpoint);
    this.leasedOperations.add(input.operationKey);
    return { checkpoint, owned: true, leaseToken: "lease-1" };
  }

  async finish(input: Parameters<ActionCheckpointRepository["finish"]>[0]) {
    if (this.failFinish) throw new Error("checkpoint finish unavailable");
    this.finishes.push(input.operationKey);
    const current = this.rows.get(input.operationKey);
    if (!current) throw new Error("missing checkpoint");
    const checkpoint: ActionCheckpoint = {
      ...current,
      status: input.status,
      result: input.result,
      errorCode: input.errorCode ?? null,
    };
    this.rows.set(input.operationKey, checkpoint);
    this.leasedOperations.delete(input.operationKey);
    return checkpoint;
  }

  async execute(input: Parameters<ActionCheckpointRepository["execute"]>[0]) {
    const current = this.rows.get(input.operationKey);
    if (!current) throw new Error("missing checkpoint");
    if (current.status !== "running") return current;
    if (this.failExecuteBeforeCommit) {
      throw new Error("execute unavailable before commit");
    }
    this.beforeExecute?.();
    if (this.cancelledTurns.has(current.turnMessageId)) {
      const cancelled: ActionCheckpoint = {
        ...current,
        status: "cancelled",
        result: { ok: false, cancelled: true },
        errorCode: "turn_cancelled",
      };
      this.rows.set(input.operationKey, cancelled);
      this.leasedOperations.delete(input.operationKey);
      return cancelled;
    }
    this.executions.push(input.operationKey);
    if (this.executeFailureCode) {
      const failed: ActionCheckpoint = {
        ...current,
        status: "failed",
        result: { ok: false, error: this.executeFailureCode },
        errorCode: this.executeFailureCode,
      };
      this.rows.set(input.operationKey, failed);
      this.leasedOperations.delete(input.operationKey);
      return failed;
    }
    const draft: ActionDraft = {
      ...DRAFT,
      id: current.targetId,
      status:
        current.actionType === "move_on_board"
          ? (current.arguments.status as ActionDraft["status"])
          : DRAFT.status,
      plan_to_post_on:
        current.actionType === "schedule_post"
          ? (current.arguments.date as string | null)
          : DRAFT.plan_to_post_on,
    };
    const checkpoint: ActionCheckpoint = {
      ...current,
      status: "committed",
      result: { ok: true, draft },
      errorCode: null,
    };
    this.rows.set(input.operationKey, checkpoint);
    this.leasedOperations.delete(input.operationKey);
    await this.afterExecute?.();
    if (this.loseExecuteResponse) {
      this.loseExecuteResponse = false;
      throw new Error("response lost");
    }
    return checkpoint;
  }

  async cancelTurn(
    input: Parameters<ActionCheckpointRepository["cancelTurn"]>[0],
  ) {
    if (this.failCancelAttempts > 0) {
      this.failCancelAttempts -= 1;
      throw new Error("turn cancellation unavailable");
    }
    this.cancelledTurns.add(input.turnMessageId);
    for (const [key, checkpoint] of this.rows) {
      if (
        checkpoint.turnMessageId === input.turnMessageId &&
        checkpoint.status === "running"
      ) {
        this.rows.set(key, {
          ...checkpoint,
          status: "cancelled",
          result: { ok: false, cancelled: true },
          errorCode: "turn_cancelled",
        });
        this.leasedOperations.delete(key);
      }
    }
  }

  async isTurnCancelled(
    input: Parameters<ActionCheckpointRepository["isTurnCancelled"]>[0],
  ) {
    this.isTurnCancelledCalls += 1;
    if (this.isTurnCancelledCalls === this.cancelOnIsTurnCancelledCall) {
      this.cancelledTurns.add(input.turnMessageId);
    }
    return this.cancelledTurns.has(input.turnMessageId);
  }

  async releaseTurnLeases(
    input: Parameters<ActionCheckpointRepository["releaseTurnLeases"]>[0],
  ) {
    this.releaseCalls += 1;
    if (this.cancelledTurns.has(input.turnMessageId)) {
      throw new Error("cancelled action turn cannot release leases");
    }
    for (const checkpoint of this.rows.values()) {
      if (
        checkpoint.turnMessageId === input.turnMessageId &&
        checkpoint.status === "running"
      ) {
        this.leasedOperations.delete(checkpoint.operationKey);
      }
    }
  }

  async resetUncommittedTurn(
    input: Parameters<ActionCheckpointRepository["resetUncommittedTurn"]>[0],
  ) {
    this.resetCalls += 1;
    if (this.failResetAttempts > 0) {
      this.failResetAttempts -= 1;
      throw new Error("checkpoint reset unavailable");
    }
    if (this.cancelledTurns.has(input.turnMessageId)) {
      throw new Error("cancelled action turn cannot be reset");
    }
    const scoped = [...this.rows.values()].filter(
      (checkpoint) => checkpoint.turnMessageId === input.turnMessageId,
    );
    if (
      scoped.some(
        (checkpoint) =>
          checkpoint.status === "committed" || checkpoint.status === "failed",
      )
    ) {
      throw new Error("executed action turn cannot be reset");
    }
    for (const checkpoint of scoped) this.rows.delete(checkpoint.operationKey);
    for (const checkpoint of scoped) {
      this.leasedOperations.delete(checkpoint.operationKey);
    }
  }
}

function orchestratorInput(
  overrides: Partial<ActionOrchestratorInput> = {},
): ActionOrchestratorInput {
  return {
    workspaceId: "ws-1",
    chatId: "22222222-2222-4222-8222-222222222222",
    turnMessageId: "33333333-3333-4333-8333-333333333333",
    userInstruction: "Mark the SaaS pricing draft ready.",
    history: [{ role: "user", content: "Mark the SaaS pricing draft ready." }],
    route: MOVE_ROUTE,
    ...overrides,
  };
}

async function collect(
  input: ActionOrchestratorInput,
  adapters: ActionOrchestratorAdapter[],
  checkpoints: ActionCheckpointRepository,
  runTool: ActionOrchestratorDependencies["runTool"],
  overrides: Partial<ActionOrchestratorDependencies> = {},
) {
  const events: AgentEvent[] = [];
  const recorded: unknown[][] = [];
  for await (const event of runActionOrchestrator(input, {
    adapters,
    checkpoints,
    runTool,
    recordUsage: vi.fn(async (...args: unknown[]) => {
      recorded.push(args);
    }),
    idFactory: (() => {
      let value = 0;
      return () => `action-call-${++value}`;
    })(),
    turnDeadlineMs: 85_000,
    ...overrides,
  })) {
    events.push(event);
  }
  return { events, recorded };
}

function mutationPlan(): { actions: MutationAction[] } {
  return {
    actions: [
      {
        id: "move",
        type: "move_on_board",
        draftId: DRAFT.id,
        status: "ready",
      },
    ],
  };
}

describe("action orchestrator contract", () => {
  test("primary follows the one app-wide chat model; fallback is independent", () => {
    // Normalized: the orchestrator primary defaults to OPENROUTER_CHAT_MODEL so
    // every text-LLM call uses the SAME model. The fallback stays its own model.
    expect(PRIMARY_ACTION_ORCHESTRATOR_MODEL).toBe(CHAT_MODEL);
    expect(FALLBACK_ACTION_ORCHESTRATOR_MODEL).toBe("google/gemini-3.5-flash");
  });

  test.each([
    ["Move the Legacy pricing draft to ready.", ["Legacy pricing"]],
    [
      "Move the hiring and pricing drafts to ready.",
      ["hiring", "pricing"],
    ],
    [
      "Move the “Hiring playbook” and “Pricing teardown” drafts to ready.",
      ["Hiring playbook", "Pricing teardown"],
    ],
    [
      "Move the “How to write posts that convert” draft to ready.",
      ["How to write posts that convert"],
    ],
    [
      "Move the How to write posts that convert draft to ready.",
      ["How to write posts that convert"],
    ],
    ["Move the draft “Legacy pricing” to ready.", ["Legacy pricing"]],
    ["Move draft “Legacy pricing” to ready.", ["Legacy pricing"]],
    ["Set the post “Pricing” for Friday.", ["Pricing"]],
    [
      "Set my post From Draft to Ready for Friday.",
      ["From Draft to Ready"],
    ],
    [
      "Set my post “From Idea to Ready” for Friday.",
      ["From Idea to Ready"],
    ],
    [
      "Set my post How to Move to Ready for Friday.",
      ["How to Move to Ready"],
    ],
    [
      "Schedule the Legacy pricing draft.\n\nClarification answer: Friday",
      ["Legacy pricing"],
    ],
    [
      "Remove the planned dates from the hiring and pricing posts.",
      ["hiring", "pricing"],
    ],
    [
      "Remove the planned dates from the hiring draft and pricing post.",
      ["hiring", "pricing"],
    ],
  ] as const)("extracts bounded saved-title lookup queries from %s", (instruction, expected) => {
    expect(actionDraftTitleQueries(instruction)).toEqual(expected);
  });

  test("extracts noun-per-item and quoted multi-target title forms", () => {
    expect(
      actionDraftTitleQueries(
        "Move the hiring draft and pricing post to ready.",
        2,
      ),
    ).toEqual(["hiring", "pricing"]);
    expect(
      actionDraftTitleQueries(
        "Move the “How posts spread” and “Draft systems” drafts to ready.",
        2,
      ),
    ).toEqual(["How posts spread", "Draft systems"]);
  });

  test("rejects unknown targets, altered requirements, and semantic duplicates", () => {
    expect(() =>
      parseActionPlan(MOVE_ROUTE, [DRAFT], {
        actions: [
          {
            id: "move",
            type: "move_on_board",
            draftId: "99999999-9999-4999-8999-999999999999",
            status: "ready",
          },
        ],
      }),
    ).toThrow(/target/i);
    expect(() =>
      parseActionPlan(MOVE_ROUTE, [DRAFT], {
        actions: [
          {
            id: "move",
            type: "move_on_board",
            draftId: DRAFT.id,
            status: "idea",
          },
        ],
      }),
    ).toThrow(/authorized/i);
    expect(() =>
      parseActionPlan(
        { ...MOVE_ROUTE, targetCount: 2 },
        [DRAFT],
        {
          actions: [
            {
              id: "one",
              type: "move_on_board",
              draftId: DRAFT.id,
              status: "ready",
            },
            {
              id: "two",
              type: "move_on_board",
              draftId: DRAFT.id,
              status: "ready",
            },
          ],
        },
      ),
    ).toThrow(/duplicate/i);
  });

  test("requires combined mutations to target the same saved draft set", () => {
    const other = { ...DRAFT, id: "44444444-4444-4444-8444-444444444444" };
    expect(() =>
      parseActionPlan(
        {
          kind: "action_management",
          targetCount: 1,
          requirements: [
            { type: "move_on_board", status: "ready" },
            { type: "schedule_post", date: "2026-07-17" },
          ],
        },
        [DRAFT, other],
        {
          actions: [
            {
              id: "move",
              type: "move_on_board",
              draftId: DRAFT.id,
              status: "ready",
            },
            {
              id: "schedule",
              type: "schedule_post",
              draftId: other.id,
              date: "2026-07-17",
            },
          ],
        },
      ),
    ).toThrow(/same drafts/i);
  });

  test("multi-target ambiguity must expose enough candidates for an exact selection", () => {
    const second = { ...DRAFT, id: "44444444-4444-4444-8444-444444444444" };
    expect(() =>
      parseActionPlan(
        { ...MOVE_ROUTE, targetCount: 3 },
        [DRAFT, second],
        {
          actions: [
            {
              id: "clarify",
              type: "clarify_target",
              candidateDraftIds: [DRAFT.id, second.id],
            },
          ],
        },
      ),
    ).toThrow(/enough candidate/i);
  });

  test("candidate labels stay globally unique when a generated suffix matches a real title", () => {
    const candidates = [
      { ...DRAFT, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "Foo" },
      { ...DRAFT, id: "bbbbbb11-bbbb-4bbb-8bbb-bbbbbbbbbbbb", title: "Foo" },
      {
        ...DRAFT,
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        title: "Foo (bbbbbb)",
      },
    ];
    const labels = candidateOptionLabels(candidates);
    expect(new Set(labels).size).toBe(3);
    expect(labels).toEqual([
      "Foo (aaaaaa)",
      "Foo (bbbbbb11)",
      "Foo (bbbbbb)",
    ]);
  });

  test("operation keys are stable for semantic actions and scoped to the turn", () => {
    const input = orchestratorInput();
    const action = mutationPlan().actions[0];
    const first = actionOperationKey(input.turnMessageId, action);
    expect(actionOperationKey(input.turnMessageId, { ...action, id: "different" })).toBe(
      first,
    );
    expect(actionOperationKey("55555555-5555-4555-8555-555555555555", action)).not.toBe(
      first,
    );
  });

  test("a retry plan must exactly match the server-recorded semantic set", () => {
    const input = orchestratorInput();
    const key = actionOperationKey(input.turnMessageId, mutationPlan().actions[0]);
    const checkpoint: ActionCheckpoint = {
      id: "checkpoint-1",
      workspaceId: input.workspaceId,
      chatId: input.chatId,
      turnMessageId: input.turnMessageId,
      operationKey: key,
      actionType: "move_on_board",
      targetId: DRAFT.id,
      arguments: { id: DRAFT.id, status: "ready" },
      status: "running",
      result: null,
      errorCode: null,
    };
    expect(() =>
      assertPlanMatchesCheckpoints(input.turnMessageId, [checkpoint], {
        actions: [
          {
            ...mutationPlan().actions[0],
            draftId: "44444444-4444-4444-8444-444444444444",
          },
        ],
      }),
    ).toThrow(/checkpointed action set/i);
  });
});

describe("checkpointed action execution", () => {
  test("records safe database stages for checkpoint list, claim, and execute", async () => {
    const sink = vi.fn();
    const telemetry = createCoworkTurnTelemetry(
      {
        traceId: "action-db-stages",
        workspaceId: "ws-1",
        route: "action_orchestrator",
        requestedContract: {
          kind: "saved_draft_action",
          expectedCount: 1,
        },
      },
      sink,
    );
    const planner = new ScriptedAdapter(PRIMARY_ACTION_ORCHESTRATOR_MODEL, [
      { toolArgs: mutationPlan(), usage: usage(80, 20) },
    ]);
    await collect(
      orchestratorInput({ telemetry }),
      [planner],
      new MemoryCheckpoints(),
      async (name) =>
        name === "list_drafts"
          ? { ok: true, count: 1, drafts: [DRAFT] }
          : { ok: true, draft: { ...DRAFT, status: "ready" } },
    );
    telemetry.finish({
      deliveredContract: { kind: "saved_draft_action", deliveredCount: 1 },
      provenanceStatus: "not_required",
      terminalOutcome: "delivered",
    });

    const record = sink.mock.calls[0][0];
    expect(record.stage_attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "action_list_drafts",
          provider: "database",
          outcome: "accepted",
        }),
        expect.objectContaining({
          stage: "checkpoint_list",
          provider: "database",
          outcome: "accepted",
        }),
        expect.objectContaining({
          stage: "checkpoint_claim",
          provider: "database",
          outcome: "accepted",
        }),
        expect.objectContaining({
          stage: "checkpoint_execute",
          provider: "database",
          outcome: "accepted",
        }),
      ]),
    );
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(DRAFT.id);
    expect(serialized).not.toContain("lease-1");
  });

  test("records a failed saved-draft listing stage without leaking query data", async () => {
    const sink = vi.fn();
    const telemetry = createCoworkTurnTelemetry(
      {
        traceId: "action-list-failed",
        workspaceId: "ws-1",
        route: "action_orchestrator",
        requestedContract: {
          kind: "saved_draft_action",
          expectedCount: 1,
        },
      },
      sink,
    );
    const result = await collect(
      orchestratorInput({ telemetry }),
      [new ScriptedAdapter(PRIMARY_ACTION_ORCHESTRATOR_MODEL, [])],
      new MemoryCheckpoints(),
      async (name) =>
        name === "list_drafts"
          ? { ok: false, error: "private database response" }
          : { ok: true },
    );
    telemetry.finish({
      deliveredContract: { kind: "saved_draft_action", deliveredCount: 0 },
      provenanceStatus: "not_required",
      terminalOutcome: "recoverable_error",
    });

    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "error",
        code: "action_draft_list_failed",
      }),
    );
    expect(sink.mock.calls[0][0].stage_attempts).toContainEqual(
      expect.objectContaining({
        stage: "action_list_drafts",
        provider: "database",
        outcome: "failed",
        reason_code: "action_list_drafts_failed",
      }),
    );
    expect(JSON.stringify(sink.mock.calls[0][0])).not.toContain(
      "private database response",
    );
  });

  test("checkpoints a successful mutation and sends its operation key to the executor", async () => {
    const providerModel = "openai/gpt-5.6-luna-20260715";
    const planner = new ScriptedAdapter(PRIMARY_ACTION_ORCHESTRATOR_MODEL, [
      { toolArgs: mutationPlan(), usage: usage(80, 20), model: providerModel },
    ]);
    const checkpoints = new MemoryCheckpoints();
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const result = await collect(
      orchestratorInput(),
      [planner],
      checkpoints,
      async (name, args) => {
        calls.push({ name, args });
        if (name === "list_drafts") {
          return { ok: true, count: 1, drafts: [DRAFT] };
        }
        return { ok: true, draft: { ...DRAFT, status: "ready" } };
      },
    );

    const mutation = result.events.find(
      (event) => event.type === "tool_start" && event.name === "move_on_board",
    );
    expect(mutation).toMatchObject({
      type: "tool_start",
      args: expect.stringContaining(checkpoints.claims[0]),
    });
    expect(calls.map((call) => call.name)).toEqual(["list_drafts"]);
    expect(checkpoints.executions).toEqual(checkpoints.claims);
    expect(result.recorded[0]).toMatchObject([
      "cowork_action_orchestrator",
      providerModel,
      expect.anything(),
      "ws-1",
      {
        stage: "primary",
        requested_model: PRIMARY_ACTION_ORCHESTRATOR_MODEL,
      },
    ]);
    expect([...checkpoints.rows.values()][0]).toMatchObject({
      status: "committed",
      actionType: "move_on_board",
      targetId: DRAFT.id,
    });
    expect(
      result.events.find((event) => event.type === "done"),
    ).toMatchObject({
      type: "done",
      terminalReason: "done",
      message: { content: expect.stringMatching(/ready/i) },
    });
  });

  test("finds every named multi-target draft outside the recent-items window", async () => {
    const secondDraft = {
      ...DRAFT,
      id: "66666666-6666-4666-8666-666666666666",
      title: "Hiring",
    };
    const route: ActionOrchestratorRoute = {
      kind: "action_management",
      targetCount: 2,
      requirements: [{ type: "move_on_board", status: "ready" }],
    };
    const listArgs: Record<string, unknown>[] = [];
    const result = await collect(
      orchestratorInput({
        route,
        userInstruction: "Move the hiring draft and pricing post to ready.",
      }),
      [
        new ScriptedAdapter(PRIMARY_ACTION_ORCHESTRATOR_MODEL, [
          {
            toolArgs: {
              actions: [
                ...mutationPlan().actions,
                {
                  id: "move-hiring",
                  type: "move_on_board",
                  draftId: secondDraft.id,
                  status: "ready",
                },
              ],
            },
          },
        ]),
      ],
      new MemoryCheckpoints(),
      async (name, args) => {
        if (name !== "list_drafts") return { ok: true };
        listArgs.push(args);
        return args.title_query === "hiring"
          ? { ok: true, count: 1, drafts: [secondDraft] }
          : { ok: true, count: 1, drafts: [DRAFT] };
      },
    );

    expect(listArgs).toEqual([
      { title_query: "hiring" },
      { title_query: "pricing" },
    ]);
    expect(result.events.find((event) => event.type === "done")).toMatchObject({
      terminalReason: "done",
      message: { content: expect.stringMatching(/Updated 2 saved drafts/i) },
    });
  });

  test("reports a named lookup miss instead of claiming the whole board is empty", async () => {
    const planner = new ScriptedAdapter(PRIMARY_ACTION_ORCHESTRATOR_MODEL, [
      { toolArgs: mutationPlan() },
    ]);
    const result = await collect(
      orchestratorInput({
        userInstruction: "Move the Missing pricing draft to ready.",
      }),
      [planner],
      new MemoryCheckpoints(),
      async () => ({ ok: true, count: 0, drafts: [] }),
    );

    expect(planner.requests).toHaveLength(0);
    expect(result.events.find((event) => event.type === "done")).toMatchObject({
      terminalReason: "done",
      message: {
        content: expect.stringMatching(/couldn’t find.*Missing pricing/i),
      },
    });
    expect(JSON.stringify(result.events)).not.toMatch(/no saved drafts on your board/i);
  });

  test("provider fallback resumes a committed checkpoint without replaying the mutation", async () => {
    const input = orchestratorInput();
    const checkpoints = new MemoryCheckpoints();
    const key = actionOperationKey(input.turnMessageId, mutationPlan().actions[0]);
    checkpoints.rows.set(key, {
      id: "checkpoint-existing",
      workspaceId: input.workspaceId,
      chatId: input.chatId,
      turnMessageId: input.turnMessageId,
      operationKey: key,
      actionType: "move_on_board",
      targetId: DRAFT.id,
      arguments: { id: DRAFT.id, status: "ready" },
      status: "committed",
      result: { ok: true, draft: { ...DRAFT, status: "ready" } },
      errorCode: null,
    });
    const primary = new ScriptedAdapter(PRIMARY_ACTION_ORCHESTRATOR_MODEL, [
      new Error("provider unavailable"),
    ]);
    const fallback = new ScriptedAdapter(FALLBACK_ACTION_ORCHESTRATOR_MODEL, [
      { toolArgs: mutationPlan(), usage: usage(70, 15) },
    ]);
    const mutation = vi.fn(async () => ({ ok: true }));
    const result = await collect(
      input,
      [primary, fallback],
      checkpoints,
      async (name) => {
        if (name === "list_drafts") {
          return { ok: true, count: 1, drafts: [{ ...DRAFT, status: "ready" }] };
        }
        return mutation();
      },
    );

    expect(primary.requests).toHaveLength(0);
    expect(fallback.requests).toHaveLength(0);
    expect(mutation).not.toHaveBeenCalled();
    expect(JSON.stringify(result.events)).toContain("already committed");
  });

  test("an open primary planner circuit falls back before claiming a checkpoint", async () => {
    const health = new AdapterHealthRegistry({
      minimumSamples: 1,
      failureRateToOpen: 1,
      slowRateToOpen: 1,
      openCooldownMs: 60_000,
    });
    health.recordFailure(
      `cowork_action_orchestrator:${PRIMARY_ACTION_ORCHESTRATOR_MODEL}`,
      "provider_5xx",
      1,
    );
    const checkpoints = new MemoryCheckpoints();
    const primary = new ScriptedAdapter(PRIMARY_ACTION_ORCHESTRATOR_MODEL, [
      new Error("must not be called"),
    ]);
    const fallback = new ScriptedAdapter(FALLBACK_ACTION_ORCHESTRATOR_MODEL, [
      { toolArgs: mutationPlan(), usage: usage(70, 15) },
    ]);
    const result = await collect(
      orchestratorInput(),
      [primary, fallback],
      checkpoints,
      async (name) =>
        name === "list_drafts"
          ? { ok: true, count: 1, drafts: [DRAFT] }
          : { ok: true },
      { adapterHealth: health },
    );

    expect(primary.requests).toHaveLength(0);
    expect(fallback.requests).toHaveLength(1);
    expect(checkpoints.claims).toHaveLength(1);
    expect(checkpoints.executions).toHaveLength(1);
    expect(result.events.find((event) => event.type === "done")).toMatchObject({
      terminalReason: "done",
    });
  });

  test("a malformed tool plan counts as an adapter failure and opens its circuit", async () => {
    const health = new AdapterHealthRegistry({
      minimumSamples: 1,
      failureRateToOpen: 1,
      slowRateToOpen: 1,
      openCooldownMs: 60_000,
    });
    const primary = new ScriptedAdapter(PRIMARY_ACTION_ORCHESTRATOR_MODEL, [
      {
        toolArgs: {
          actions: [
            {
              id: "wrong",
              type: "move_on_board",
              draftId: DRAFT.id,
              status: "idea",
            },
          ],
        },
        usage: usage(70, 15),
      },
    ]);
    const fallback = new ScriptedAdapter(FALLBACK_ACTION_ORCHESTRATOR_MODEL, [
      { toolArgs: mutationPlan(), usage: usage(70, 15) },
    ]);
    await collect(
      orchestratorInput(),
      [primary, fallback],
      new MemoryCheckpoints(),
      async (name) =>
        name === "list_drafts"
          ? { ok: true, count: 1, drafts: [DRAFT] }
          : { ok: true },
      { adapterHealth: health },
    );

    expect(
      health.snapshot(
        `cowork_action_orchestrator:${PRIMARY_ACTION_ORCHESTRATOR_MODEL}`,
      ),
    ).toMatchObject({ state: "open", failureRate: 1 });
    expect(fallback.requests).toHaveLength(1);
  });

  test("does not replay a terminal failed checkpoint or describe it as in flight", async () => {
    const input = orchestratorInput();
    const checkpoints = new MemoryCheckpoints();
    const key = actionOperationKey(input.turnMessageId, mutationPlan().actions[0]);
    checkpoints.rows.set(key, {
      id: "checkpoint-failed",
      workspaceId: input.workspaceId,
      chatId: input.chatId,
      turnMessageId: input.turnMessageId,
      operationKey: key,
      actionType: "move_on_board",
      targetId: DRAFT.id,
      arguments: { id: DRAFT.id, status: "ready" },
      status: "failed",
      result: { ok: false, error: "postcondition_not_met" },
      errorCode: "postcondition_not_met",
    });
    const mutation = vi.fn(async () => ({ ok: true }));
    const result = await collect(
      input,
      [
        new ScriptedAdapter(PRIMARY_ACTION_ORCHESTRATOR_MODEL, [
          { toolArgs: mutationPlan() },
        ]),
      ],
      checkpoints,
      async (name) => {
        if (name === "list_drafts") {
          return { ok: true, count: 1, drafts: [DRAFT] };
        }
        return mutation();
      },
    );

    expect(mutation).not.toHaveBeenCalled();
    expect(JSON.stringify(result.events)).toContain("will not replay");
    expect(JSON.stringify(result.events)).not.toContain("already being finished");
    expect(result.events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "error",
          code: "action_checkpoint_reconciliation_failed",
        }),
      ]),
    );
    expect(result.events.find((event) => event.type === "done")).toMatchObject({
      type: "done",
      terminalReason: "error",
    });
  });

  test("reports a known execute rejection as a hard failure, not uncertain cancellation", async () => {
    const checkpoints = new MemoryCheckpoints();
    checkpoints.executeFailureCode = "locked";
    const result = await collect(
      orchestratorInput(),
      [
        new ScriptedAdapter(PRIMARY_ACTION_ORCHESTRATOR_MODEL, [
          { toolArgs: mutationPlan() },
        ]),
      ],
      checkpoints,
      async (name) =>
        name === "list_drafts"
          ? { ok: true, count: 1, drafts: [DRAFT] }
          : { ok: true },
    );

    expect(checkpoints.executions).toHaveLength(1);
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "error",
          code: "action_checkpoint_not_committed",
        }),
      ]),
    );
    expect(result.events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "error",
          code: "action_checkpoint_reconciliation_failed",
        }),
      ]),
    );
    expect(result.events.find((event) => event.type === "done")).toMatchObject({
      type: "done",
      terminalReason: "error",
      message: { content: expect.stringMatching(/rejected/i) },
    });
  });

  test("fails closed before a side effect when checkpoint claiming is unavailable", async () => {
    const checkpoints = new MemoryCheckpoints();
    checkpoints.failClaim = true;
    const mutation = vi.fn(async () => ({ ok: true }));
    const result = await collect(
      orchestratorInput(),
      [
        new ScriptedAdapter(PRIMARY_ACTION_ORCHESTRATOR_MODEL, [
          { toolArgs: mutationPlan() },
        ]),
      ],
      checkpoints,
      async (name) =>
        name === "list_drafts"
          ? { ok: true, count: 1, drafts: [DRAFT] }
          : mutation(),
    );

    expect(mutation).not.toHaveBeenCalled();
    expect(JSON.stringify(result.events)).toMatch(/checkpoint/i);
  });

  test("a partial pre-execution claim failure resets atomically and remains safely retryable", async () => {
    const route: ActionOrchestratorRoute = {
      kind: "action_management",
      targetCount: 1,
      requirements: [
        { type: "move_on_board", status: "ready" },
        { type: "schedule_post", date: "2026-07-17" },
      ],
    };
    const plan = {
      actions: [
        ...mutationPlan().actions,
        {
          id: "schedule",
          type: "schedule_post" as const,
          draftId: DRAFT.id,
          date: "2026-07-17",
        },
      ],
    };
    const checkpoints = new MemoryCheckpoints();
    checkpoints.failClaimAt = 2;
    checkpoints.failResetAttempts = 2;
    const first = await collect(
      orchestratorInput({ route }),
      [
        new ScriptedAdapter(PRIMARY_ACTION_ORCHESTRATOR_MODEL, [
          { toolArgs: plan },
        ]),
      ],
      checkpoints,
      async () => ({ ok: true, count: 1, drafts: [DRAFT] }),
    );

    expect(checkpoints.executions).toHaveLength(0);
    expect([...checkpoints.rows.values()]).toEqual([]);
    expect(checkpoints.resetCalls).toBe(3);
    expect(first.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "error",
          recovery: "continue",
        }),
      ]),
    );

    checkpoints.failClaimAt = null;
    const planner = new ScriptedAdapter(PRIMARY_ACTION_ORCHESTRATOR_MODEL, [
      { toolArgs: plan },
    ]);
    const runTool = vi.fn(async (name: string) =>
      name === "list_drafts"
        ? { ok: true, count: 1, drafts: [DRAFT] }
        : { ok: true },
    );
    const retry = await collect(
      orchestratorInput({ route }),
      [planner],
      checkpoints,
      runTool,
    );
    expect(planner.requests).toHaveLength(1);
    expect(checkpoints.executions).toHaveLength(2);
    expect([...checkpoints.rows.values()]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "committed" }),
        expect.objectContaining({ status: "committed" }),
      ]),
    );
    expect(retry.events.some((event) => event.type === "error")).toBe(false);
  });

  test("Retry clears a crash-left partial claim set before rebuilding the complete plan", async () => {
    const input = orchestratorInput({
      route: {
        kind: "action_management",
        targetCount: 1,
        requirements: [
          { type: "move_on_board", status: "ready" },
          { type: "schedule_post", date: "2026-07-17" },
        ],
      },
    });
    const checkpoints = new MemoryCheckpoints();
    const move = mutationPlan().actions[0];
    const moveKey = actionOperationKey(input.turnMessageId, move);
    checkpoints.rows.set(moveKey, {
      id: "checkpoint-crash-left",
      workspaceId: input.workspaceId,
      chatId: input.chatId,
      turnMessageId: input.turnMessageId,
      operationKey: moveKey,
      actionType: "move_on_board",
      targetId: DRAFT.id,
      arguments: { id: DRAFT.id, status: "ready" },
      status: "running",
      result: null,
      errorCode: null,
    });
    checkpoints.failResetAttempts = 2;
    const planner = new ScriptedAdapter(PRIMARY_ACTION_ORCHESTRATOR_MODEL, [
      {
        toolArgs: {
          actions: [
            move,
            {
              id: "schedule",
              type: "schedule_post",
              draftId: DRAFT.id,
              date: "2026-07-17",
            },
          ],
        },
      },
    ]);

    const result = await collect(
      input,
      [planner],
      checkpoints,
      async (name) =>
        name === "list_drafts"
          ? { ok: true, count: 1, drafts: [DRAFT] }
          : { ok: true },
    );

    expect(checkpoints.resetCalls).toBe(3);
    expect(planner.requests).toHaveLength(1);
    expect(checkpoints.executions).toHaveLength(2);
    expect([...checkpoints.rows.values()]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "committed" }),
        expect.objectContaining({ status: "committed" }),
      ]),
    );
    expect(result.events.some((event) => event.type === "error")).toBe(false);
  });

  test("reconciles a lost atomic-execute response from its committed checkpoint", async () => {
    const checkpoints = new MemoryCheckpoints();
    checkpoints.loseExecuteResponse = true;
    await collect(
      orchestratorInput(),
      [
        new ScriptedAdapter(PRIMARY_ACTION_ORCHESTRATOR_MODEL, [
          { toolArgs: mutationPlan() },
        ]),
      ],
      checkpoints,
      async () => ({ ok: true, count: 1, drafts: [DRAFT] }),
    );

    expect(checkpoints.executions).toHaveLength(1);
    expect([...checkpoints.rows.values()][0].status).toBe("committed");
  });

  test("double-transient reconciliation never rejects or cancels a committed multi-action plan", async () => {
    const route: ActionOrchestratorRoute = {
      kind: "action_management",
      targetCount: 1,
      requirements: [
        { type: "move_on_board", status: "ready" },
        { type: "schedule_post", date: "2026-07-17" },
      ],
    };
    const checkpoints = new MemoryCheckpoints();
    checkpoints.loseExecuteResponse = true;
    checkpoints.failListCalls.add(2);
    checkpoints.failListCalls.add(3);
    const result = await collect(
      orchestratorInput({ route }),
      [
        new ScriptedAdapter(PRIMARY_ACTION_ORCHESTRATOR_MODEL, [
          {
            toolArgs: {
              actions: [
                ...mutationPlan().actions,
                {
                  id: "schedule",
                  type: "schedule_post",
                  draftId: DRAFT.id,
                  date: "2026-07-17",
                },
              ],
            },
          },
        ]),
      ],
      checkpoints,
      async (name) =>
        name === "list_drafts"
          ? { ok: true, count: 1, drafts: [DRAFT] }
          : { ok: true },
    );

    expect(checkpoints.listCalls).toBeGreaterThanOrEqual(4);
    expect(checkpoints.executions).toHaveLength(2);
    expect(checkpoints.cancelledTurns.size).toBe(0);
    expect([...checkpoints.rows.values()].every(
      (checkpoint) => checkpoint.status === "committed",
    )).toBe(true);
    expect(result.events.some((event) => event.type === "error")).toBe(false);
    expect(result.events.find((event) => event.type === "done")).toMatchObject({
      type: "done",
      terminalReason: "done",
    });
  });

  test("a permanently fenced uncertain action never offers an impossible Retry", async () => {
    const checkpoints = new MemoryCheckpoints();
    checkpoints.failExecuteBeforeCommit = true;
    checkpoints.failListCalls.add(2);
    checkpoints.failListCalls.add(3);
    checkpoints.failListCalls.add(4);

    const result = await collect(
      orchestratorInput(),
      [
        new ScriptedAdapter(PRIMARY_ACTION_ORCHESTRATOR_MODEL, [
          { toolArgs: mutationPlan() },
        ]),
      ],
      checkpoints,
      async (name) =>
        name === "list_drafts"
          ? { ok: true, count: 1, drafts: [DRAFT] }
          : { ok: true },
    );

    expect(checkpoints.executions).toHaveLength(0);
    expect(checkpoints.cancelledTurns).toContain(
      orchestratorInput().turnMessageId,
    );
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "error",
          code: "action_checkpoint_reconciliation_failed",
        }),
      ]),
    );
    expect(result.events.some(
      (event) => event.type === "error" && event.recovery === "continue",
    )).toBe(false);
    expect(result.events.find((event) => event.type === "done")).toMatchObject({
      terminalReason: "error",
      message: { content: expect.not.stringMatching(/Retry/i) },
    });
  });

  test("a retry cannot rebind an existing checkpoint to a different valid draft", async () => {
    const checkpoints = new MemoryCheckpoints();
    const input = orchestratorInput();
    const key = actionOperationKey(input.turnMessageId, mutationPlan().actions[0]);
    checkpoints.rows.set(key, {
      id: "checkpoint-existing",
      workspaceId: input.workspaceId,
      chatId: input.chatId,
      turnMessageId: input.turnMessageId,
      operationKey: key,
      actionType: "move_on_board",
      targetId: DRAFT.id,
      arguments: { id: DRAFT.id, status: "ready" },
      status: "committed",
      result: { ok: true, draft: { ...DRAFT, status: "ready" } },
      errorCode: null,
    });
    const other = { ...DRAFT, id: "44444444-4444-4444-8444-444444444444" };
    const primary = new ScriptedAdapter(PRIMARY_ACTION_ORCHESTRATOR_MODEL, [
      {
        toolArgs: {
          actions: [{ ...mutationPlan().actions[0], draftId: other.id }],
        },
      },
    ]);
    const fallback = new ScriptedAdapter(FALLBACK_ACTION_ORCHESTRATOR_MODEL, [
      { toolArgs: mutationPlan() },
    ]);
    await collect(
      input,
      [primary, fallback],
      checkpoints,
      async () => ({ ok: true, count: 2, drafts: [DRAFT, other] }),
    );

    expect(primary.requests).toHaveLength(0);
    expect(fallback.requests).toHaveLength(0);
    expect(checkpoints.executions).toHaveLength(0);
    expect(checkpoints.rows.has(key)).toBe(true);
  });

  test("cancellation after one committed action prevents every pending mutation", async () => {
    const secondDraft = {
      ...DRAFT,
      id: "66666666-6666-4666-8666-666666666666",
      title: "Hiring",
    };
    const route: ActionOrchestratorRoute = {
      kind: "action_management",
      targetCount: 2,
      requirements: [{ type: "move_on_board", status: "ready" }],
    };
    let cancel = false;
    const checkpoints = new MemoryCheckpoints();
    const input = orchestratorInput({
      route,
      cancellationProbe: async () => cancel,
    });
    checkpoints.afterExecute = () => {
      checkpoints.cancelledTurns.add(input.turnMessageId);
      cancel = true;
    };
    const result = await collect(
      input,
      [
        new ScriptedAdapter(PRIMARY_ACTION_ORCHESTRATOR_MODEL, [
          {
            toolArgs: {
              actions: [
                ...mutationPlan().actions,
                {
                  id: "move-two",
                  type: "move_on_board",
                  draftId: secondDraft.id,
                  status: "ready",
                },
              ],
            },
          },
        ]),
      ],
      checkpoints,
      async (name) =>
        name === "list_drafts"
          ? { ok: true, count: 2, drafts: [DRAFT, secondDraft] }
          : { ok: false },
    );

    expect(checkpoints.claims).toHaveLength(2);
    expect(checkpoints.executions).toHaveLength(1);
    expect(checkpoints.cancelledTurns).toContain(
      input.turnMessageId,
    );
    expect([...checkpoints.rows.values()]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "committed" }),
        expect.objectContaining({ status: "cancelled" }),
      ]),
    );
    expect(
      result.events.find((event) => event.type === "done"),
    ).toMatchObject({ type: "done", terminalReason: "cancelled" });
  });

  test("a reliability deadline leaves committed and pending checkpoints retryable", async () => {
    const secondDraft = {
      ...DRAFT,
      id: "66666666-6666-4666-8666-666666666666",
      title: "Hiring",
    };
    const route: ActionOrchestratorRoute = {
      kind: "action_management",
      targetCount: 2,
      requirements: [{ type: "move_on_board", status: "ready" }],
    };
    const plan = {
      actions: [
        ...mutationPlan().actions,
        {
          id: "move-two",
          type: "move_on_board" as const,
          draftId: secondDraft.id,
          status: "ready" as const,
        },
      ],
    };
    const input = orchestratorInput({ route });
    const checkpoints = new MemoryCheckpoints();
    checkpoints.afterExecute = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    };
    const first = await collect(
      input,
      [
        new ScriptedAdapter(PRIMARY_ACTION_ORCHESTRATOR_MODEL, [
          { toolArgs: plan },
        ]),
      ],
      checkpoints,
      async (name) =>
        name === "list_drafts"
          ? { ok: true, count: 2, drafts: [DRAFT, secondDraft] }
          : { ok: true },
      { turnDeadlineMs: 1 },
    );

    expect(checkpoints.executions).toHaveLength(1);
    expect(checkpoints.cancelledTurns.size).toBe(0);
    expect([...checkpoints.rows.values()]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "committed" }),
        expect.objectContaining({ status: "running" }),
      ]),
    );
    expect(first.events.find((event) => event.type === "done")).toMatchObject({
      type: "done",
      terminalReason: "deadline",
      message: { content: expect.stringMatching(/Retry.*without replaying/i) },
    });
    expect(first.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "error",
          recovery: "continue",
        }),
      ]),
    );
    expect(checkpoints.releaseCalls).toBe(1);

    checkpoints.afterExecute = null;
    const retry = await collect(
      input,
      [new ScriptedAdapter(PRIMARY_ACTION_ORCHESTRATOR_MODEL, [])],
      checkpoints,
      async () => ({ ok: true }),
    );
    expect(checkpoints.executions).toHaveLength(2);
    expect([...checkpoints.rows.values()].every(
      (checkpoint) => checkpoint.status === "committed",
    )).toBe(true);
    expect(retry.events.find((event) => event.type === "done")).toMatchObject({
      type: "done",
      terminalReason: "done",
    });
  });

  test("a tombstone arriving during atomic execution prevents the side effect", async () => {
    const input = orchestratorInput();
    const checkpoints = new MemoryCheckpoints();
    checkpoints.beforeExecute = () => {
      checkpoints.cancelledTurns.add(input.turnMessageId);
    };
    const result = await collect(
      input,
      [
        new ScriptedAdapter(PRIMARY_ACTION_ORCHESTRATOR_MODEL, [
          { toolArgs: mutationPlan() },
        ]),
      ],
      checkpoints,
      async (name) =>
        name === "list_drafts"
          ? { ok: true, count: 1, drafts: [DRAFT] }
          : { ok: true },
    );

    expect(checkpoints.executions).toHaveLength(0);
    expect([...checkpoints.rows.values()][0]).toMatchObject({
      status: "cancelled",
      errorCode: "turn_cancelled",
    });
    expect(result.events.find((event) => event.type === "done")).toMatchObject({
      type: "done",
      terminalReason: "cancelled",
    });
  });

  test("a pre-existing cancellation tombstone makes a later claim terminal", async () => {
    const input = orchestratorInput();
    const checkpoints = new MemoryCheckpoints();
    checkpoints.cancelledTurns.add(input.turnMessageId);
    const result = await collect(
      input,
      [
        new ScriptedAdapter(PRIMARY_ACTION_ORCHESTRATOR_MODEL, [
          { toolArgs: mutationPlan() },
        ]),
      ],
      checkpoints,
      async () => ({ ok: true, count: 1, drafts: [DRAFT] }),
    );

    expect(checkpoints.executions).toHaveLength(0);
    expect([...checkpoints.rows.values()][0]?.status).toBe("cancelled");
    expect(result.events.find((event) => event.type === "done")).toMatchObject({
      type: "done",
      terminalReason: "cancelled",
    });
  });

  test("durable cancellation retries transient tombstone write failures", async () => {
    const input = orchestratorInput({ cancellationProbe: async () => true });
    const checkpoints = new MemoryCheckpoints();
    checkpoints.cancelledTurns.add(input.turnMessageId);
    checkpoints.failCancelAttempts = 2;
    const result = await collect(
      input,
      [new ScriptedAdapter(PRIMARY_ACTION_ORCHESTRATOR_MODEL, [])],
      checkpoints,
      async () => ({ ok: true }),
    );

    expect(checkpoints.cancelledTurns).toContain(input.turnMessageId);
    expect(result.events.find((event) => event.type === "done")).toMatchObject({
      type: "done",
      terminalReason: "cancelled",
    });
    expect(result.events.some(
      (event) => event.type === "error" && event.recovery === "continue",
    )).toBe(false);
  });

  test("a transport abort stays retryable and never creates a Stop tombstone", async () => {
    const controller = new AbortController();
    controller.abort();
    const checkpoints = new MemoryCheckpoints();
    const result = await collect(
      orchestratorInput({
        signal: controller.signal,
        cancellationProbe: async () => false,
      }),
      [new ScriptedAdapter(PRIMARY_ACTION_ORCHESTRATOR_MODEL, [])],
      checkpoints,
      async () => ({ ok: true }),
    );

    expect(checkpoints.cancelledTurns.size).toBe(0);
    expect(result.events.find((event) => event.type === "done")).toMatchObject({
      type: "done",
      terminalReason: "cancelled",
      message: { content: expect.stringMatching(/Retry.*reconcile/i) },
    });
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "error",
          recovery: "continue",
        }),
      ]),
    );
  });

  test("a Stop tombstone racing an input abort wins over transport recovery", async () => {
    const controller = new AbortController();
    controller.abort();
    const input = orchestratorInput({
      signal: controller.signal,
      cancellationProbe: async () => true,
    });
    const checkpoints = new MemoryCheckpoints();
    checkpoints.cancelOnIsTurnCancelledCall = 2;

    const result = await collect(
      input,
      [new ScriptedAdapter(PRIMARY_ACTION_ORCHESTRATOR_MODEL, [])],
      checkpoints,
      async () => ({ ok: true }),
    );

    expect(checkpoints.isTurnCancelledCalls).toBeGreaterThanOrEqual(2);
    expect(checkpoints.cancelledTurns).toContain(input.turnMessageId);
    expect(result.events.some(
      (event) => event.type === "error" && event.recovery === "continue",
    )).toBe(false);
    expect(result.events.find((event) => event.type === "done")).toMatchObject({
      type: "done",
      terminalReason: "cancelled",
      message: { content: expect.not.stringMatching(/Retry/i) },
    });
  });

  test("an input abort still waits for a Stop tombstone that lands after the boundary probe", async () => {
    const controller = new AbortController();
    controller.abort();
    const input = orchestratorInput({
      signal: controller.signal,
      // The pre-RPC browser abort reaches the worker before the separate Stop
      // request has committed its tombstone, so the boundary probe loses the
      // race even though this is an explicit user Stop.
      cancellationProbe: async () => false,
    });
    const checkpoints = new MemoryCheckpoints();
    checkpoints.cancelOnIsTurnCancelledCall = 2;

    const result = await collect(
      input,
      [new ScriptedAdapter(PRIMARY_ACTION_ORCHESTRATOR_MODEL, [])],
      checkpoints,
      async () => ({ ok: true }),
    );

    expect(checkpoints.isTurnCancelledCalls).toBeGreaterThanOrEqual(2);
    expect(checkpoints.cancelledTurns).toContain(input.turnMessageId);
    expect(result.events.some(
      (event) => event.type === "error" && event.recovery === "continue",
    )).toBe(false);
    expect(result.events.find((event) => event.type === "done")).toMatchObject({
      type: "done",
      terminalReason: "cancelled",
      message: { content: expect.not.stringMatching(/Retry/i) },
    });
  });

  test("a cancellation is not reported as safe when its durable fence never persists", async () => {
    const checkpoints = new MemoryCheckpoints();
    const input = orchestratorInput({ cancellationProbe: async () => true });
    checkpoints.cancelledTurns.add(input.turnMessageId);
    checkpoints.failCancelAttempts = 3;
    await expect(
      collect(
        input,
        [new ScriptedAdapter(PRIMARY_ACTION_ORCHESTRATOR_MODEL, [])],
        checkpoints,
        async () => ({ ok: true }),
      ),
    ).rejects.toThrow(/durably fenced/i);
    expect(checkpoints.cancelledTurns).toContain(input.turnMessageId);
  });

  test("disallowed and missing-date routes never call a planner or side effect", async () => {
    const planner = new ScriptedAdapter(PRIMARY_ACTION_ORCHESTRATOR_MODEL, []);
    const runTool = vi.fn(async () => ({ ok: true }));
    const denied = await collect(
      orchestratorInput({
        route: { kind: "disallowed_action", disallowedReason: "publish" },
      }),
      [planner],
      new MemoryCheckpoints(),
      runTool,
    );
    const clarify = await collect(
      orchestratorInput({
        route: { kind: "clarify_action", clarificationReason: "date" },
      }),
      [planner],
      new MemoryCheckpoints(),
      runTool,
    );

    expect(planner.requests).toHaveLength(0);
    expect(runTool).not.toHaveBeenCalled();
    expect(JSON.stringify(denied.events)).toMatch(/publish/i);
    expect(clarify.events.some((event) => event.type === "ask")).toBe(true);
    const clarifyDone = clarify.events.find((event) => event.type === "done");
    expect(
      clarifyDone?.type === "done"
        ? JSON.parse(
            clarifyDone.message.tool_calls?.[0]?.function.arguments ?? "{}",
          )
        : {},
    ).toMatchObject({ actionLane: true });
  });
});
