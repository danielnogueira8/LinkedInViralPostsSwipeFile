import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  present: vi.fn(),
}));

vi.mock("@/lib/content-learning/workspace-learning", () => ({
  createWorkspaceLearningStore: () => ({
    refresh: mocks.refresh,
  }),
}));
vi.mock(
  "@/lib/content-learning/workspace-learning-presentation",
  () => ({
    presentWorkspaceLearning: mocks.present,
  }),
);
vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({
    raw: { name: "database" },
    workspaceId: "workspace-1",
  }),
}));

const { GET } = await import("@/app/api/agent/working-summary/route");

beforeEach(() => {
  mocks.refresh.mockReset();
  mocks.present.mockReset();
});

describe("GET /api/agent/working-summary", () => {
  test("resolves the active evidence-backed model through the freshness check", async () => {
    const active = { id: "learning-1", status: "active" };
    const summary = { sourceMode: "published_posts" };
    mocks.refresh.mockResolvedValue(active);
    mocks.present.mockReturnValue(summary);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      summary,
    });
    expect(mocks.refresh).toHaveBeenCalledWith("workspace-1", {
      mode: "active",
    });
    expect(mocks.present).toHaveBeenCalledWith(active);
  });

  test("activates the first model when no active snapshot exists", async () => {
    const active = { id: "learning-2", status: "active" };
    const summary = { sourceMode: "voice_exemplars" };
    mocks.refresh.mockResolvedValue(active);
    mocks.present.mockReturnValue(summary);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      summary,
    });
    expect(mocks.refresh).toHaveBeenCalledWith("workspace-1", {
      mode: "active",
    });
  });
});
