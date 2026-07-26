import { beforeEach, describe, expect, test, vi } from "vitest";

const state: {
  rpcError: { message: string } | null;
  settingError: { message: string } | null;
} = {
  rpcError: null,
  settingError: null,
};

const rpc = vi.fn(async () => ({ data: null, error: state.rpcError }));
const upsertSetting = vi.fn(async () => ({ error: state.settingError }));
const enqueueScrapeJob = vi.fn();

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({
    workspaceId: "workspace-from-session",
    raw: { rpc },
    upsertSetting,
  }),
}));

vi.mock("@/lib/scrape-jobs", () => ({
  enqueueScrapeJob: (...args: unknown[]) => enqueueScrapeJob(...args),
}));

vi.mock("@/lib/workspace", () => ({
  errorResponse: (error: unknown) =>
    Response.json(
      { ok: false, error: (error as Error | { message?: string })?.message ?? "Unexpected error" },
      { status: 500 },
    ),
}));

const { POST } = await import("@/app/api/onboarding/complete/route");

function request(body: unknown): Request {
  return new Request("https://app.tryswipein.com/api/onboarding/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.rpcError = null;
  state.settingError = null;
  rpc.mockClear();
  upsertSetting.mockClear();
  enqueueScrapeJob.mockClear();
});

describe("POST /api/onboarding/complete — recurring queue provisioning", () => {
  test("provisions defaults in the browser timezone before completing onboarding", async () => {
    const response = await POST(request({ timezone: "Europe/Lisbon" }));

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("ensure_posting_slots", {
      p_workspace_id: "workspace-from-session",
      p_timezone: "Europe/Lisbon",
    });
    expect(upsertSetting).toHaveBeenCalledWith("onboarded_at", {
      at: expect.any(String),
    });
    expect(rpc.mock.invocationCallOrder[0]).toBeLessThan(
      upsertSetting.mock.invocationCallOrder[0],
    );
  });

  test("older clients receive UTC defaults", async () => {
    const response = await POST(request({}));

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("ensure_posting_slots", {
      p_workspace_id: "workspace-from-session",
      p_timezone: "UTC",
    });
  });

  test("rejects an invalid timezone without provisioning or completing onboarding", async () => {
    const response = await POST(request({ timezone: "not/a-timezone" }));

    expect(response.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
    expect(upsertSetting).not.toHaveBeenCalled();
  });

  test("never trusts a client-supplied workspace id", async () => {
    await POST(
      request({
        timezone: "America/New_York",
        workspace_id: "another-workspace",
      }),
    );

    expect(rpc).toHaveBeenCalledWith("ensure_posting_slots", {
      p_workspace_id: "workspace-from-session",
      p_timezone: "America/New_York",
    });
  });

  test("a provisioning failure prevents onboarding from being marked complete", async () => {
    state.rpcError = { message: "slot provisioning failed" };

    const response = await POST(request({ timezone: "UTC" }));

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "slot provisioning failed",
    });
    expect(upsertSetting).not.toHaveBeenCalled();
  });
});
