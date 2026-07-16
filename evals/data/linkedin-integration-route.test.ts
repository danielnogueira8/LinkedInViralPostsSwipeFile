import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// POST /api/integrations/linkedin — the "start connecting" endpoint.
//
// Guard under test: when the workspace is ALREADY connected (canPublish true),
// the route must short-circuit with { ok:true, alreadyConnected:true } and
// NEVER call Zernio's /connect (getConnectUrl). Re-initiating on an already-
// connected profile makes Zernio 400, which used to surface the nonsensical
// "Publishing failed (400)" toast on the Connect screen. When NOT connected,
// the route proceeds to build the hosted-OAuth authUrl as before.
// ---------------------------------------------------------------------------

type ConnectUrlOpts = { platform: string; profileId: string; redirectUrl: string };
const requireWorkspaceId = vi.fn<() => Promise<string>>(async () => "user_1");
const getConnection = vi.fn<(id: string) => Promise<unknown>>();
const canPublish = vi.fn<(conn: unknown) => boolean>();
const ensureProfile = vi.fn<(id: string) => Promise<string>>(async () => "profile_1");
const getConnectUrl = vi.fn<(opts: ConnectUrlOpts) => Promise<string>>(
  async () => "https://zernio.com/hosted/auth?x=1",
);
const deleteAccount = vi.fn(async () => true);
const markDisconnected = vi.fn(async () => {});

vi.mock("@/lib/workspace", () => ({
  requireWorkspaceId: () => requireWorkspaceId(),
  // Mirror the real errorResponse envelope so a thrown error is observable.
  errorResponse: (e: unknown) =>
    Response.json(
      { ok: false, error: (e as Error)?.message ?? "Unexpected error" },
      { status: 500 },
    ),
}));

vi.mock("@/lib/publishing", () => ({
  getConnection: (id: string) => getConnection(id),
  canPublish: (conn: unknown) => canPublish(conn),
  ensureProfile: (id: string) => ensureProfile(id),
  markDisconnected: (...a: unknown[]) => markDisconnected(...(a as [])),
}));

vi.mock("@/lib/zernio", () => ({
  getConnectUrl: (opts: { platform: string; profileId: string; redirectUrl: string }) =>
    getConnectUrl(opts),
  deleteAccount: (...a: unknown[]) => deleteAccount(...(a as [])),
}));

const { POST } = await import("@/app/api/integrations/linkedin/route");

function post(url = "https://app.tryswipein.com/api/integrations/linkedin") {
  return new Request(url, { method: "POST" });
}

describe("POST /api/integrations/linkedin — already-connected guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceId.mockResolvedValue("user_1");
    getConnectUrl.mockResolvedValue("https://zernio.com/hosted/auth?x=1");
    ensureProfile.mockResolvedValue("profile_1");
  });
  afterEach(() => vi.clearAllMocks());

  test("already connected → { alreadyConnected:true }, Zernio never called", async () => {
    getConnection.mockResolvedValue({
      status: "active",
      zernio_account_id: "acct_1",
      display_name: "Daniel Nogueira",
    });
    canPublish.mockReturnValue(true);

    const res = await POST(post());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, alreadyConnected: true, displayName: "Daniel Nogueira" });
    expect(getConnectUrl).not.toHaveBeenCalled();
    expect(ensureProfile).not.toHaveBeenCalled();
  });

  test("not connected → proceeds to hosted OAuth (authUrl), no alreadyConnected flag", async () => {
    getConnection.mockResolvedValue(null);
    canPublish.mockReturnValue(false);

    const res = await POST(post());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.authUrl).toContain("zernio.com/hosted/auth");
    expect(body.alreadyConnected).toBeUndefined();
    expect(ensureProfile).toHaveBeenCalledWith("user_1");
    expect(getConnectUrl).toHaveBeenCalledTimes(1);
  });

  test("carries returnTo=welcome into the finalize redirectUrl (allow-listed)", async () => {
    getConnection.mockResolvedValue(null);
    canPublish.mockReturnValue(false);

    await POST(post("https://app.tryswipein.com/api/integrations/linkedin?returnTo=welcome"));

    const arg = getConnectUrl.mock.calls[0][0] as { redirectUrl: string };
    expect(arg.redirectUrl).toContain("/api/integrations/linkedin/finalize");
    expect(arg.redirectUrl).toContain("returnTo=welcome");
  });

  test("an arbitrary returnTo is NOT reflected (defaults to Settings)", async () => {
    getConnection.mockResolvedValue(null);
    canPublish.mockReturnValue(false);

    await POST(post("https://app.tryswipein.com/api/integrations/linkedin?returnTo=https://evil.example"));

    const arg = getConnectUrl.mock.calls[0][0] as { redirectUrl: string };
    expect(arg.redirectUrl).not.toContain("returnTo=");
    expect(arg.redirectUrl).not.toContain("evil.example");
  });
});
