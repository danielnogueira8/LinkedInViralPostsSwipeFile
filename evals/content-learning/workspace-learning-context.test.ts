import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  render: vi.fn(),
}));

vi.mock("@/lib/content-learning/workspace-learning", () => ({
  createWorkspaceLearningStore: () => ({
    refresh: mocks.refresh,
  }),
}));
vi.mock(
  "@/lib/content-learning/workspace-learning-presentation",
  () => ({
    renderWorkspaceLearningBlock: mocks.render,
  }),
);

const { loadWorkspaceLearningBlock } = await import(
  "@/lib/content-learning/workspace-learning-context"
);

beforeEach(() => {
  mocks.refresh.mockReset();
  mocks.render.mockReset();
});

describe("Cowork Workspace Learning context", () => {
  test("renders the active model", async () => {
    const active = { status: "active", id: "learning-1" };
    mocks.refresh.mockResolvedValue(active);
    mocks.render.mockReturnValue("evidence block");

    await expect(
      loadWorkspaceLearningBlock(
        {} as SupabaseClient,
        "workspace-1",
      ),
    ).resolves.toBe("evidence block");
    expect(mocks.refresh).toHaveBeenCalledWith("workspace-1", {
      mode: "active",
    });
    expect(mocks.render).toHaveBeenCalledWith(active);
  });

  test("does not expose a shadow model to Cowork", async () => {
    mocks.refresh.mockResolvedValue({
      status: "shadow",
      id: "learning-shadow",
    });

    await expect(
      loadWorkspaceLearningBlock(
        {} as SupabaseClient,
        "workspace-1",
      ),
    ).resolves.toBe("");
    expect(mocks.render).not.toHaveBeenCalled();
  });
});
