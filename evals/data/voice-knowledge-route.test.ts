import { beforeEach, describe, expect, test, vi } from "vitest";

const review = vi.fn();
const archive = vi.fn();

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({
    workspaceId: "workspace-1",
    raw: {},
  }),
}));
vi.mock("@/lib/content-learning/workspace-knowledge", () => ({
  createWorkspaceKnowledgeStore: () => ({
    review,
    archive,
  }),
}));

const { PATCH } = await import("@/app/api/voice/knowledge/[id]/route");

function request(body: unknown) {
  return new Request("http://test/api/voice/knowledge/knowledge-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const context = {
  params: Promise.resolve({ id: "10000000-0000-4000-8000-000000000001" }),
};

beforeEach(() => {
  review.mockReset();
  archive.mockReset();
});

describe("Voice Knowledge review route", () => {
  test("approves with the authenticated Workspace and expected version", async () => {
    review.mockResolvedValue({ id: "knowledge-1", verification: "verified" });
    const response = await PATCH(
      request({
        action: "approve",
        expectedUpdatedAt: "2026-07-26T14:00:00.000Z",
      }),
      context,
    );
    expect(response.status).toBe(200);
    expect(review).toHaveBeenCalledWith("workspace-1", {
      itemId: "10000000-0000-4000-8000-000000000001",
      expectedUpdatedAt: "2026-07-26T14:00:00.000Z",
      decision: "approve",
      replacement: null,
    });
  });

  test("archives through the versioned archive operation", async () => {
    archive.mockResolvedValue({ id: "knowledge-1", active: false });
    const response = await PATCH(
      request({
        action: "archive",
        expectedUpdatedAt: "2026-07-26T14:00:00.000Z",
      }),
      context,
    );
    expect(response.status).toBe(200);
    expect(archive).toHaveBeenCalledWith(
      "workspace-1",
      "10000000-0000-4000-8000-000000000001",
      "2026-07-26T14:00:00.000Z",
    );
  });

  test("returns a conflict for stale or missing knowledge", async () => {
    review.mockResolvedValue(null);
    const response = await PATCH(
      request({
        action: "reject",
        expectedUpdatedAt: "2026-07-26T14:00:00.000Z",
      }),
      context,
    );
    expect(response.status).toBe(409);
  });

  test("rejects malformed keyboard or scripted submissions", async () => {
    const response = await PATCH(
      request({ action: "approve", expectedUpdatedAt: "yesterday" }),
      context,
    );
    expect(response.status).toBe(400);
    expect(review).not.toHaveBeenCalled();
  });

  test("rejects an invalid item id before touching storage", async () => {
    const response = await PATCH(
      request({
        action: "approve",
        expectedUpdatedAt: "2026-07-26T14:00:00.000Z",
      }),
      { params: Promise.resolve({ id: "not-a-uuid" }) },
    );
    expect(response.status).toBe(400);
    expect(review).not.toHaveBeenCalled();
  });
});
