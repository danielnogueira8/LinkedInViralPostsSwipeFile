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

const modelRouting = {
  planner: {
    news: { strategy: "server_compiled", model: null },
    read_only: { primary: "planner-primary", fallback: "planner-fallback" },
  },
  search: { primary: "search-primary", fallback: "search-fallback" },
  writer: {
    primary: "writer-primary",
    fallback: "writer-fallback",
    thin_primary: "thin-primary",
    thin_fallback: "thin-fallback",
  },
};

vi.mock("@/lib/agent/model-config", () => ({
  activeCoworkModelRouting: () => modelRouting,
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
  expect(body.models).toEqual(modelRouting);
  expect(body).not.toHaveProperty("error");
});

test("does not expose database errors in the public response", async () => {
  state.error = { message: 'relation "public.settings" does not exist' };

  const response = await GET();
  const body = await response.json();

  expect(response.status).toBe(503);
  expect(body).toMatchObject({ ok: false, db: "down" });
  expect(body.models).toEqual(modelRouting);
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

test("clears the database timeout when the query rejects", async () => {
  vi.useFakeTimers();
  const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
  state.error = new Error("database request rejected");
  state.throwOnQuery = true;

  try {
    const response = await GET();

    expect(response.status).toBe(503);
    expect(clearTimeoutSpy).toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
