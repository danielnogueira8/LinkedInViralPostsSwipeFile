import { describe, expect, test, vi } from "vitest";

const getToken = vi.fn(async () => "supabase-clerk-token");
const requestClient = { kind: "rls-request-client" };
const supabaseForWorkspaceRequest = vi.fn(
  (getAccessToken: () => Promise<string | null>, workspaceId: string) => {
    void getAccessToken;
    void workspaceId;
    return requestClient;
  },
);
const supabaseAdmin = vi.fn(() => {
  throw new Error("authenticated requests must not use the service role");
});

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: "user_123", getToken }),
}));

vi.mock("@/lib/supabase", () => ({
  supabaseForWorkspaceRequest,
  supabaseAdmin,
}));

const { scopedSupabase } = await import("@/lib/supabase-scoped");

describe("scopedSupabase request authentication", () => {
  test("returns a Clerk-authenticated client instead of the service-role client", async () => {
    const scoped = await scopedSupabase();

    expect(scoped).toMatchObject({
      workspaceId: "user_123",
      raw: requestClient,
    });
    expect(supabaseAdmin).not.toHaveBeenCalled();
    expect(supabaseForWorkspaceRequest).toHaveBeenCalledOnce();

    const accessToken = supabaseForWorkspaceRequest.mock.calls[0]?.[0];
    await expect(accessToken?.()).resolves.toBe("supabase-clerk-token");
    expect(getToken).toHaveBeenCalledWith();
  });
});
