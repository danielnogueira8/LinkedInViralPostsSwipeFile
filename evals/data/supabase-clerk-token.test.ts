import { afterAll, afterEach, describe, expect, test, vi } from "vitest";

vi.stubGlobal("WebSocket", class WebSocket {});

const clerkTemplateError = Object.assign(new Error("Not Found"), {
  clerkError: true,
  code: "api_response_error",
  status: 404,
  errors: [
    {
      code: "resource_not_found",
      message: "JWT template not found",
      longMessage: "No JWT template exists with name: supabase",
    },
  ],
});

const getToken = vi.fn(async (options?: { template?: string }) => {
  if (options?.template === "supabase") throw clerkTemplateError;
  return "clerk-session-token";
});

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: "user_123", getToken }),
}));

const { supabaseForRequest } = await import("@/lib/supabase");
const { requireWorkspaceSession } = await import("@/lib/workspace");

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("Clerk-authenticated Supabase requests", () => {
  test("initializes Realtime without requesting a missing Clerk JWT template", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = await requireWorkspaceSession();

    supabaseForRequest(session.getSupabaseToken);

    await vi.waitFor(() => {
      expect(warn).not.toHaveBeenCalledWith(
        "Failed to set initial Realtime auth token:",
        clerkTemplateError,
      );
      expect(getToken).toHaveBeenCalledWith();
    });
  });
});
