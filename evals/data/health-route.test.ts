import { afterEach, beforeEach, expect, test, vi } from "vitest";

const state: { error: Error | { message: string } | null; throwOnQuery: boolean } = {
  error: null,
  throwOnQuery: false,
};

const chain: Record<string, unknown> = {};
Object.assign(chain, {
  select: () => chain,
  abortSignal: async () => {
    if (state.throwOnQuery) throw state.error;
    return { error: state.error };
  },
});

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({ from: () => chain }),
}));

const { GET } = await import("@/app/api/health/route");

beforeEach(() => {
  state.error = null;
  state.throwOnQuery = false;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("returns a healthy public response without implementation details", async () => {
  const response = await GET();
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body).toMatchObject({ ok: true, db: "up" });
  expect(body).not.toHaveProperty("error");
});

test("does not expose database errors in the public response", async () => {
  state.error = { message: 'relation "public.settings" does not exist' };

  const response = await GET();
  const body = await response.json();

  expect(response.status).toBe(503);
  expect(body).toMatchObject({ ok: false, db: "down" });
  expect(body).not.toHaveProperty("error");
  expect(console.error).toHaveBeenCalledWith(
    expect.stringContaining("health_check_failed"),
  );
});

test("does not expose thrown infrastructure errors", async () => {
  state.error = new Error("getaddrinfo ENOTFOUND private-db.internal");
  state.throwOnQuery = true;

  const response = await GET();
  const body = await response.json();

  expect(response.status).toBe(503);
  expect(body).not.toHaveProperty("error");
  expect(console.error).toHaveBeenCalledWith(
    expect.stringContaining("health_check_failed"),
  );
});
