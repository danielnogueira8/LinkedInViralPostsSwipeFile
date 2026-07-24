import { afterEach, describe, expect, test, vi } from "vitest";

// Covers productionResolveDecisionDeps.listWorkspaceNiches — the real
// list_niches read + its normalization + fail-open. The main resolver tests
// inject a fake deps, so this is the only place the production niche fetch is
// exercised. Mock runTool so no DB is touched.

const runTool = vi.fn();
vi.mock("@/lib/agent/tools", () => ({
  runTool: (...args: unknown[]) => runTool(...args),
}));

const { productionResolveDecisionDeps } = await import(
  "@/lib/agent/turn/resolve-decision"
);

afterEach(() => {
  runTool.mockReset();
});

describe("productionResolveDecisionDeps.listWorkspaceNiches", () => {
  test("returns the niche names from a successful list_niches result", async () => {
    runTool.mockResolvedValue({
      ok: true,
      niches: [
        { niche: "SaaS", count: 12 },
        { niche: "AI/Tech", count: 8 },
      ],
    });
    const niches =
      await productionResolveDecisionDeps.listWorkspaceNiches("ws-1");
    expect(niches).toEqual(["SaaS", "AI/Tech"]);
    expect(runTool).toHaveBeenCalledWith("list_niches", {}, "ws-1");
  });

  test("drops entries without a usable string niche", async () => {
    runTool.mockResolvedValue({
      ok: true,
      niches: [
        { niche: "SaaS" },
        { niche: "" },
        { niche: null },
        { count: 3 },
        "not-an-object",
        { niche: "Sales" },
      ],
    });
    expect(
      await productionResolveDecisionDeps.listWorkspaceNiches("ws-1"),
    ).toEqual(["SaaS", "Sales"]);
  });

  test("returns [] when the tool reports not ok", async () => {
    runTool.mockResolvedValue({ ok: false, error: "nope" });
    expect(
      await productionResolveDecisionDeps.listWorkspaceNiches("ws-1"),
    ).toEqual([]);
  });

  test("returns [] when niches is missing or not an array", async () => {
    runTool.mockResolvedValue({ ok: true });
    expect(
      await productionResolveDecisionDeps.listWorkspaceNiches("ws-1"),
    ).toEqual([]);
    runTool.mockResolvedValue({ ok: true, niches: "oops" });
    expect(
      await productionResolveDecisionDeps.listWorkspaceNiches("ws-1"),
    ).toEqual([]);
  });

  test("returns [] when the result is null or not an object", async () => {
    runTool.mockResolvedValue(null);
    expect(
      await productionResolveDecisionDeps.listWorkspaceNiches("ws-1"),
    ).toEqual([]);
  });

  test("fails open to [] when the tool throws — a niche blip never blocks a read-back", async () => {
    runTool.mockRejectedValue(new Error("db down"));
    expect(
      await productionResolveDecisionDeps.listWorkspaceNiches("ws-1"),
    ).toEqual([]);
  });
});
