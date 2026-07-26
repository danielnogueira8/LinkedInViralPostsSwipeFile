import { beforeEach, describe, expect, test, vi } from "vitest";

const ingest = vi.fn();
const listByDraft = vi.fn();
const correct = vi.fn();
let draftExists = true;
let outcomeExists = true;

function queryFor(table: string) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => {
      if (table === "chat_artifacts") {
        return {
          data: draftExists
            ? { id: "draft", status: "posted", schedule_status: null }
            : null,
          error: null,
        };
      }
      if (table === "artifact_lineage") {
        return {
          data: draftExists
            ? { id: "20000000-0000-4000-8000-000000000001" }
            : null,
          error: null,
        };
      }
      return {
        data: outcomeExists ? { id: "outcome" } : null,
        error: null,
      };
    }),
  };
  return builder;
}

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({
    workspaceId: "workspace-1",
    raw: { from: (table: string) => queryFor(table) },
  }),
}));
vi.mock("@/lib/content-learning/content-outcomes", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/lib/content-learning/content-outcomes")
    >();
  return {
    ...original,
    createContentOutcomesStore: () => ({
      ingest,
      listByDraft,
      correct,
    }),
  };
});

const outcomesRoute = await import("@/app/api/drafts/[id]/outcomes/route");
const correctionRoute = await import(
  "@/app/api/drafts/[id]/outcomes/[outcomeId]/route"
);

const draftId = "10000000-0000-4000-8000-000000000001";
const outcomeId = "30000000-0000-4000-8000-000000000001";
const requestId = "40000000-0000-4000-8000-000000000001";
const timestamp = "2026-07-26T12:00:00.000Z";

function request(url: string, method: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  ingest.mockReset();
  listByDraft.mockReset();
  correct.mockReset();
  draftExists = true;
  outcomeExists = true;
});

describe("manual Content Outcome routes", () => {
  test("creates a workspace-scoped manual outcome linked to lineage", async () => {
    ingest.mockImplementation(async (outcome) => outcome);
    const response = await outcomesRoute.POST(
      request(`http://test/api/drafts/${draftId}/outcomes`, "POST", {
        kind: "pipeline",
        quantity: 1,
        amountMinor: 125000,
        currency: "usd",
        occurredAt: timestamp,
        requestId,
      }),
      { params: Promise.resolve({ id: draftId }) },
    );
    expect(response.status).toBe(200);
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        draftId,
        lineageId: "20000000-0000-4000-8000-000000000001",
        source: "manual",
        amountMinor: 125000,
        currency: "USD",
        idempotencyKey: `manual:${draftId}:${requestId}`,
      }),
    );
  });

  test("rejects incomplete money before touching persistence", async () => {
    const response = await outcomesRoute.POST(
      request(`http://test/api/drafts/${draftId}/outcomes`, "POST", {
        kind: "pipeline",
        quantity: 1,
        amountMinor: 125000,
        currency: null,
        occurredAt: timestamp,
        requestId,
      }),
      { params: Promise.resolve({ id: draftId }) },
    );
    expect(response.status).toBe(400);
    expect(ingest).not.toHaveBeenCalled();
  });

  test("does not report an outcome against another Workspace's Draft", async () => {
    draftExists = false;
    const response = await outcomesRoute.POST(
      request(`http://test/api/drafts/${draftId}/outcomes`, "POST", {
        kind: "lead",
        quantity: 1,
        amountMinor: null,
        currency: null,
        occurredAt: timestamp,
        requestId,
      }),
      { params: Promise.resolve({ id: draftId }) },
    );
    expect(response.status).toBe(404);
    expect(ingest).not.toHaveBeenCalled();
  });

  test("lists active outcomes through the scoped store", async () => {
    listByDraft.mockResolvedValue([{ id: outcomeId }]);
    const response = await outcomesRoute.GET(
      request(`http://test/api/drafts/${draftId}/outcomes`, "GET"),
      { params: Promise.resolve({ id: draftId }) },
    );
    expect(response.status).toBe(200);
    expect(listByDraft).toHaveBeenCalledWith("workspace-1", draftId);
  });

  test("corrects only an outcome belonging to the route Draft", async () => {
    correct.mockResolvedValue({ id: "replacement" });
    const response = await correctionRoute.PATCH(
      request(
        `http://test/api/drafts/${draftId}/outcomes/${outcomeId}`,
        "PATCH",
        {
          kind: "booked_call",
          quantity: 2,
          amountMinor: null,
          currency: null,
          occurredAt: timestamp,
          expectedUpdatedAt: timestamp,
          reason: "One more call was booked.",
          requestId,
        },
      ),
      { params: Promise.resolve({ id: draftId, outcomeId }) },
    );
    expect(response.status).toBe(200);
    expect(correct).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({
        outcomeId,
        expectedUpdatedAt: timestamp,
        idempotencyKey: `manual-correction:${outcomeId}:${requestId}`,
        replacement: expect.objectContaining({
          kind: "booked_call",
          quantity: 2,
        }),
      }),
    );
  });
});
