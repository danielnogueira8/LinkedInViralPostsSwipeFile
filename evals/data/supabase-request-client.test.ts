import { beforeEach, describe, expect, test, vi } from "vitest";

const createClient = vi.fn(
  (
    _url: string,
    _key: string,
    _options: {
      auth: { persistSession: boolean; autoRefreshToken: boolean };
      accessToken: () => Promise<string | null>;
    },
  ) => ({ kind: "request-client" }),
);

vi.mock("@supabase/supabase-js", () => ({ createClient }));

const { supabaseForRequest, supabaseForWorkspaceRequest } = await import(
  "@/lib/supabase"
);

beforeEach(() => {
  createClient.mockClear();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
});

describe("supabaseForRequest", () => {
  test("uses the anon key and caller token so RLS remains authoritative", async () => {
    const getAccessToken = vi.fn(async () => "clerk-session-token");

    expect(supabaseForRequest(getAccessToken)).toEqual({
      kind: "request-client",
    });
    expect(createClient).toHaveBeenCalledWith(
      "https://project.supabase.co",
      "anon-key",
      expect.objectContaining({
        auth: { persistSession: false, autoRefreshToken: false },
        accessToken: expect.any(Function),
      }),
    );

    const options = createClient.mock.calls[0]?.[2];
    await expect(options?.accessToken?.()).resolves.toBe("clerk-session-token");
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(createClient.mock.calls[0]?.[1]).not.toBe("service-role-key");
  });

  test("fails closed when the request client configuration is missing", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    expect(() => supabaseForRequest(async () => "token")).toThrow(
      "Supabase URL or anon key missing",
    );
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe("supabaseForWorkspaceRequest", () => {
  test("keeps ordinary tables on the RLS client", () => {
    const requestFrom = vi.fn(() => "request-query");
    const serviceFrom = vi.fn(() => "service-query");
    createClient.mockReturnValueOnce({
      from: requestFrom,
      rpc: vi.fn(),
      storage: { from: vi.fn() },
    } as never);
    const serviceClient = {
      from: serviceFrom,
      rpc: vi.fn(),
      storage: { from: vi.fn() },
    };

    const client = supabaseForWorkspaceRequest(
      async () => "token",
      "user_123",
      serviceClient as never,
    );

    expect(client.from("settings")).toBe("request-query");
    expect(requestFrom).toHaveBeenCalledWith("settings");
    expect(serviceFrom).not.toHaveBeenCalled();
  });

  test("limits service-role dispatch to declared workspace-bound RPCs", () => {
    const requestRpc = vi.fn(() => "request-rpc");
    const serviceRpc = vi.fn(() => "service-rpc");
    const requestStorageFrom = vi.fn(() => "request-bucket");
    createClient.mockReturnValueOnce({
      from: vi.fn(() => "request-query"),
      rpc: requestRpc,
      storage: { from: requestStorageFrom },
    } as never);
    const serviceClient = {
      from: vi.fn(() => "service-query"),
      rpc: serviceRpc,
      storage: { from: vi.fn(() => "service-bucket") },
    };

    const client = supabaseForWorkspaceRequest(
      async () => "token",
      "user_123",
      serviceClient as never,
    );

    expect(client.rpc("match_post_embeddings", {})).toBe("request-rpc");
    expect(
      client.rpc("claim_media_quota", { p_workspace_id: "user_123" }),
    ).toBe("service-rpc");
    expect(client.storage.from("avatars")).toBe("request-bucket");
    expect(client.storage.from("media-assets")).toBe("request-bucket");
  });

  test("rejects privileged RPC calls for another workspace", () => {
    createClient.mockReturnValueOnce({
      from: vi.fn(),
      rpc: vi.fn(),
      storage: { from: vi.fn() },
    } as never);
    const client = supabaseForWorkspaceRequest(
      async () => "token",
      "user_123",
      { from: vi.fn(), rpc: vi.fn(), storage: { from: vi.fn() } } as never,
    );

    expect(() =>
      client.rpc("claim_media_quota", { p_workspace_id: "user_other" }),
    ).toThrow("Privileged RPC workspace mismatch");
  });
});
