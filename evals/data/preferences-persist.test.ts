import { describe, test, expect, vi, beforeEach } from "vitest";
import { makeFakeSupabase, queryFor, type FakeDb } from "./fake-supabase";
import { PREFS_PER_WORKSPACE_MAX } from "@/lib/preferences";

// ---------------------------------------------------------------------------
// persistLearnedPreference — the remember_preference write path.
//
// This is the one place the AGENT writes a durable rule (source='learned'), so
// the guards that keep it safe are exactly what we pin here: workspace-scoped
// insert (no cross-workspace write), dedup against existing rules, the per-
// workspace cap, empty-rule rejection, and fail-soft on a DB error. All below
// the model, deterministic. Mocks supabaseAdmin() with the recording fake.
// ---------------------------------------------------------------------------

const dbRef: { current: FakeDb } = { current: makeFakeSupabase({}) };

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => dbRef.current.client,
}));

const { persistLearnedPreference } = await import(
  "@/lib/agent/learned-preference"
);

beforeEach(() => {
  dbRef.current = makeFakeSupabase({});
});

const WS = "ws-1";

describe("persistLearnedPreference", () => {
  test("inserts a workspace-scoped learned row and returns the id", async () => {
    dbRef.current = makeFakeSupabase({
      content_preferences: { single: { id: "pref-1" } },
    });
    const out = await persistLearnedPreference(WS, "  Never use em-dashes ", []);
    expect(out).toEqual({
      ok: true,
      saved: true,
      id: "pref-1",
      rule: "Never use em-dashes",
    });

    const q = queryFor(dbRef.current, "content_preferences")!;
    const insert = q.filters.find((f) => f.method === "insert")!;
    const payload = insert.args[0] as Record<string, unknown>;
    // Scoped to the workspace + tagged as learned + normalized rule.
    expect(payload.workspace_id).toBe(WS);
    expect(payload.source).toBe("learned");
    expect(payload.rule).toBe("Never use em-dashes");
  });

  test("a restated rule is a no-op success (no insert)", async () => {
    const out = await persistLearnedPreference(WS, "never use em dashes!", [
      { rule: "Never use em-dashes" },
    ]);
    expect(out).toEqual({
      ok: true,
      saved: false,
      reason: "duplicate",
      // normalize collapses whitespace but keeps punctuation; only the DEDUP KEY
      // strips it — so the returned rule retains the "!".
      rule: "never use em dashes!",
    });
    // No content_preferences write happened at all.
    expect(queryFor(dbRef.current, "content_preferences")).toBeUndefined();
  });

  test("refuses politely at the per-workspace cap", async () => {
    const existing = Array.from({ length: PREFS_PER_WORKSPACE_MAX }, (_, i) => ({
      rule: `Rule ${i}`,
    }));
    const out = await persistLearnedPreference(WS, "A brand new rule", existing);
    expect(out.ok).toBe(true);
    expect(out).toMatchObject({ saved: false, reason: "cap" });
    expect(queryFor(dbRef.current, "content_preferences")).toBeUndefined();
  });

  test("rejects an empty / non-string rule", async () => {
    expect((await persistLearnedPreference(WS, "   ", [])).ok).toBe(false);
    expect((await persistLearnedPreference(WS, 42, [])).ok).toBe(false);
    expect((await persistLearnedPreference(WS, null, [])).ok).toBe(false);
  });

  test("fails soft on a DB error (never throws, ok:false)", async () => {
    dbRef.current = makeFakeSupabase({
      content_preferences: { error: { message: "boom" } },
    });
    const out = await persistLearnedPreference(WS, "Never use hashtags", []);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/could not save/i);
  });
});
