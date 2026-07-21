import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { LeadSharkError } from "@/lib/leadshark";

// ---------------------------------------------------------------------------
// /api/integrations/leadshark — connect (POST), status (GET), disconnect (DELETE)
// for the user-supplied LeadShark API key.
//
// Contract under test:
//  - success:   a valid key is verified live, then stored; response carries the
//               SAFE projection and NEVER the key.
//  - failure:   401/403 → 400 client-actionable; 429 → 429; transient → 502.
//               Nothing is stored on any failure.
//  - isolation: every operation resolves the workspace from the session
//               (requireWorkspaceId) and passes it to the scoped store — never
//               from client input.
//  - mutation:  store on connect, hard-delete on disconnect.
// ---------------------------------------------------------------------------

const requireWorkspaceId = vi.fn<() => Promise<string>>(async () => "user_1");
const verifyKey =
  vi.fn<(k: string) => Promise<{ ok: true } | { ok: false; error: LeadSharkError }>>();
const getCredentialSafe = vi.fn();
const storeVerifiedCredential = vi.fn();
const deleteCredential = vi.fn<(id: string) => Promise<void>>(async () => {});

vi.mock("@/lib/workspace", () => ({
  requireWorkspaceId: () => requireWorkspaceId(),
  errorResponse: (e: unknown) =>
    Response.json(
      { ok: false, error: (e as Error)?.message ?? "Unexpected error" },
      { status: 500 },
    ),
}));

vi.mock("@/lib/leadshark", () => ({
  verifyKey: (k: string) => verifyKey(k),
}));

vi.mock("@/lib/leadshark-credentials", () => ({
  getCredentialSafe: (id: string) => getCredentialSafe(id),
  storeVerifiedCredential: (id: string, k: string) => storeVerifiedCredential(id, k),
  deleteCredential: (id: string) => deleteCredential(id),
}));

const { GET, POST, DELETE } = await import("@/app/api/integrations/leadshark/route");

const SAFE = {
  connected: true,
  status: "active" as const,
  keyHint: "••••3f9a",
  lastVerifiedAt: "2026-07-21T00:00:00.000Z",
  lastError: null,
};

function post(body: unknown) {
  return new Request("https://app.tryswipein.com/api/integrations/leadshark", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("/api/integrations/leadshark", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceId.mockResolvedValue("user_1");
    storeVerifiedCredential.mockResolvedValue(SAFE);
    getCredentialSafe.mockResolvedValue(SAFE);
  });
  afterEach(() => vi.clearAllMocks());

  // --- success ---
  test("POST valid key → verifies live, stores, returns the SAFE projection (never the key)", async () => {
    verifyKey.mockResolvedValue({ ok: true });

    const res = await POST(post({ apiKey: "ls_live_realkey" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(verifyKey).toHaveBeenCalledWith("ls_live_realkey");
    expect(storeVerifiedCredential).toHaveBeenCalledWith("user_1", "ls_live_realkey");
    // The response must never echo the key back.
    expect(JSON.stringify(body)).not.toContain("ls_live_realkey");
    expect(body.credential).toMatchObject({ connected: true, keyHint: "••••3f9a" });
  });

  test("GET → returns the SAFE projection for the caller's workspace", async () => {
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(getCredentialSafe).toHaveBeenCalledWith("user_1");
    expect(body).toMatchObject({ ok: true, credential: { connected: true } });
    expect(JSON.stringify(body)).not.toContain("ciphertext");
  });

  // --- failure: nothing stored, correct status per kind ---
  test("POST rejected key (401) → 400, stores nothing", async () => {
    verifyKey.mockResolvedValue({
      ok: false,
      error: { kind: "unauthorized", status: 401, message: "LeadShark rejected your API key." },
    });
    const res = await POST(post({ apiKey: "bad" }));
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
    expect(storeVerifiedCredential).not.toHaveBeenCalled();
  });

  test("POST plan lacks API access (403) → 400, stores nothing", async () => {
    verifyKey.mockResolvedValue({
      ok: false,
      error: { kind: "forbidden", status: 403, message: "plan" },
    });
    const res = await POST(post({ apiKey: "k" }));
    expect(res.status).toBe(400);
    expect(storeVerifiedCredential).not.toHaveBeenCalled();
  });

  test("POST rate-limited (429) → 429, stores nothing", async () => {
    verifyKey.mockResolvedValue({
      ok: false,
      error: { kind: "rate_limited", status: 429, message: "slow down" },
    });
    const res = await POST(post({ apiKey: "k" }));
    expect(res.status).toBe(429);
    expect(storeVerifiedCredential).not.toHaveBeenCalled();
  });

  test("POST transient upstream failure → 502, stores nothing", async () => {
    verifyKey.mockResolvedValue({
      ok: false,
      error: { kind: "transient", status: 0, message: "unreachable" },
    });
    const res = await POST(post({ apiKey: "k" }));
    expect(res.status).toBe(502);
    expect(storeVerifiedCredential).not.toHaveBeenCalled();
  });

  test("POST empty/invalid body → 400, never calls LeadShark", async () => {
    const res = await POST(post({ apiKey: "" }));
    expect(res.status).toBe(400);
    expect(verifyKey).not.toHaveBeenCalled();
    expect(storeVerifiedCredential).not.toHaveBeenCalled();
  });

  // --- isolation ---
  test("workspace is resolved from the session, not client input", async () => {
    requireWorkspaceId.mockResolvedValue("user_isolated");
    verifyKey.mockResolvedValue({ ok: true });
    // A hostile body cannot redirect the write to another workspace.
    await POST(post({ apiKey: "k", workspace_id: "victim" }));
    expect(storeVerifiedCredential).toHaveBeenCalledWith("user_isolated", "k");
  });

  // --- mutation ---
  test("DELETE → hard-deletes the caller's credential", async () => {
    const res = await DELETE();
    expect(res.status).toBe(200);
    expect(deleteCredential).toHaveBeenCalledWith("user_1");
  });
});
