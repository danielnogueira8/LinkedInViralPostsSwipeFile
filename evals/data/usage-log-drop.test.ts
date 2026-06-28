import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// logOpenRouterUsage drop-metric (reliability finding #8). A failed usage_events
// insert silently under-counts the monthly cost cap forever — the await exists
// precisely to guarantee spend is recorded before the turn releases. Previously
// the catch only did a bare console.error (not grep-able, no context). It now
// also emits a structured `usage_log_drop` metric. We assert that contract, and
// that a successful insert emits NO drop metric.
// ---------------------------------------------------------------------------

// Swap the insert behavior per-test via a module-level handle the mock reads at
// call time.
const insertRef: { current: () => Promise<unknown> } = {
  current: async () => ({ error: null }),
};

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({
    from: () => ({ insert: (...a: unknown[]) => insertRef.current(...(a as [])) }),
  }),
}));

const { logOpenRouterUsage } = await import("@/lib/openrouter");

const USAGE = { prompt_tokens: 1000, completion_tokens: 200 };

beforeEach(() => {
  insertRef.current = async () => ({ error: null });
});
afterEach(() => {
  vi.restoreAllMocks();
});

function captureLogs(): { lines: string[] } {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args) => {
    lines.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  return { lines };
}

describe("logOpenRouterUsage — drop metric on insert failure", () => {
  test("a thrown insert emits a structured usage_log_drop with workspace + tokens", async () => {
    insertRef.current = async () => {
      throw new Error("connection reset");
    };
    const { lines } = captureLogs();

    await logOpenRouterUsage("chat", "z-ai/glm-5.2", USAGE, "ws_42");

    const drop = lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .find((o) => o && o.usage_log_drop);
    expect(drop, "expected a usage_log_drop line").toBeTruthy();
    expect(drop.usage_log_drop.workspace_id).toBe("ws_42");
    expect(drop.usage_log_drop.input_tokens).toBe(1000);
    expect(drop.usage_log_drop.output_tokens).toBe(200);
    expect(drop.usage_log_drop.model).toBe("z-ai/glm-5.2");
    expect(drop.usage_log_drop.error).toContain("connection reset");
  });

  test("a successful insert emits NO drop metric", async () => {
    const { lines } = captureLogs();
    await logOpenRouterUsage("chat", "z-ai/glm-5.2", USAGE, "ws_ok");
    expect(lines.some((l) => l.includes("usage_log_drop"))).toBe(false);
  });

  test("never throws — a logging failure must not abort the caller's turn", async () => {
    insertRef.current = async () => {
      throw new Error("boom");
    };
    captureLogs();
    await expect(
      logOpenRouterUsage("chat", "z-ai/glm-5.2", USAGE, "ws"),
    ).resolves.toBeUndefined();
  });
});
