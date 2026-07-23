import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUserWorkingSummary: vi.fn(),
  readStoredUserWorkingSummary: vi.fn(),
}));

vi.mock("@/lib/agent-loop/user-working-summary", () => mocks);
vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({
    raw: { name: "database" },
    workspaceId: "workspace-1",
  }),
}));

const { GET } = await import("@/app/api/agent/working-summary/route");

beforeEach(() => {
  mocks.getUserWorkingSummary.mockReset();
  mocks.readStoredUserWorkingSummary.mockReset();
});

describe("GET /api/agent/working-summary", () => {
  test("returns the stored weekly summary without running analysis", async () => {
    const stored = { version: 3, source: "published_posts" };
    mocks.readStoredUserWorkingSummary.mockResolvedValue(stored);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      summary: stored,
    });
    expect(mocks.getUserWorkingSummary).not.toHaveBeenCalled();
  });

  test("generates the first summary when no persisted analysis exists", async () => {
    const generated = { version: 3, source: "voice_profile" };
    mocks.readStoredUserWorkingSummary.mockResolvedValue(null);
    mocks.getUserWorkingSummary.mockResolvedValue(generated);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      summary: generated,
    });
    expect(mocks.getUserWorkingSummary).toHaveBeenCalledTimes(1);
  });
});
