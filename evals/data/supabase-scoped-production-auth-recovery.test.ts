import { describe, expect, test, vi } from "vitest";

const keyTypeError = {
  message: "No suitable key or wrong key type",
};

function categoriesClient(error: typeof keyTypeError | null) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(async () => ({ data: error ? null : [], error })),
    })),
  };
}

const requestClient = categoriesClient(keyTypeError);
const serviceClient = categoriesClient(null);
const getSupabaseToken = vi.fn(async () => "clerk-session-token");
const supabaseForWorkspaceRequest = vi.fn(() => requestClient);
const supabaseAdmin = vi.fn(() => serviceClient);

vi.mock("@/lib/workspace", () => ({
  requireWorkspaceId: async () => "user_123",
  requireWorkspaceSession: async () => ({
    workspaceId: "user_123",
    getSupabaseToken,
  }),
}));

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin,
  supabaseForWorkspaceRequest,
}));

const { scopedSupabase } = await import("@/lib/supabase-scoped");

describe("scoped Supabase production auth recovery", () => {
  test("keeps authenticated reads on the working service client", async () => {
    const scoped = await scopedSupabase();

    const result = await scoped.raw.from("categories").select();

    expect(result.error).toBeNull();
    expect(result.data).toEqual([]);
    expect(scoped.raw).toBe(serviceClient);
    expect(supabaseAdmin).toHaveBeenCalledOnce();
    expect(supabaseForWorkspaceRequest).not.toHaveBeenCalled();
    expect(getSupabaseToken).not.toHaveBeenCalled();
  });
});
