import { describe, test, expect, vi, beforeEach } from "vitest";
import { makeFakeSupabase, queryFor, type FakeDb } from "./fake-supabase";

// ---------------------------------------------------------------------------
// persistLearnedPreference — the remember_preference write path.
//
// This is the one place the AGENT writes a durable rule (source='learned'), so
// the guards that keep it safe are exactly what we pin here: workspace-scoped
// insert (no cross-workspace write), dedup against existing rules, the per-
// unbounded growth, empty-rule rejection, and fail-soft on a DB error. All below
// the model, deterministic. Mocks supabaseAdmin() with the recording fake.
// ---------------------------------------------------------------------------

const dbRef: { current: FakeDb } = { current: makeFakeSupabase({}) };

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => dbRef.current.client,
}));

const { persistLearnedPreference } =
  await import("@/lib/agent/learned-preference");

beforeEach(() => {
  dbRef.current = makeFakeSupabase({});
});

const WS = "ws-1";

describe("persistLearnedPreference", () => {
  test("inserts a workspace-scoped learned row and returns the id", async () => {
    dbRef.current = makeFakeSupabase({
      content_preferences: { single: { id: "pref-1" } },
    });
    const out = await persistLearnedPreference(
      WS,
      "  Never use em-dashes ",
      [],
    );
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

  test("passes an optional detail through, normalized, to the insert", async () => {
    dbRef.current = makeFakeSupabase({
      content_preferences: { single: { id: "pref-2" } },
    });
    await persistLearnedPreference(
      WS,
      "Cite current traction numbers",
      [],
      "  Grew 50,000+ followers; built $150,000+ in pipeline.  ",
    );
    const q = queryFor(dbRef.current, "content_preferences")!;
    const insert = q.filters.find((f) => f.method === "insert")!;
    const payload = insert.args[0] as Record<string, unknown>;
    expect(payload.detail).toBe(
      "Grew 50,000+ followers; built $150,000+ in pipeline.",
    );
  });

  test("omitting detail inserts null, not undefined or empty string", async () => {
    dbRef.current = makeFakeSupabase({
      content_preferences: { single: { id: "pref-3" } },
    });
    await persistLearnedPreference(WS, "Never use hashtags", []);
    const q = queryFor(dbRef.current, "content_preferences")!;
    const insert = q.filters.find((f) => f.method === "insert")!;
    const payload = insert.args[0] as Record<string, unknown>;
    expect(payload.detail).toBeNull();
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

  test("continues saving beyond the former 20-rule boundary", async () => {
    dbRef.current = makeFakeSupabase({
      content_preferences: { single: { id: "pref-21" } },
    });
    const existing = Array.from({ length: 20 }, (_, i) => ({
      rule: `Rule ${i}`,
    }));
    const out = await persistLearnedPreference(
      WS,
      "A brand new rule",
      existing,
    );
    expect(out).toMatchObject({ ok: true, saved: true, id: "pref-21" });
    expect(queryFor(dbRef.current, "content_preferences")).toBeDefined();
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

  test("treats a database dedup race as a duplicate no-op", async () => {
    dbRef.current = makeFakeSupabase({
      content_preferences: {
        error: { code: "23505", message: "duplicate key" } as never,
      },
    });

    await expect(
      persistLearnedPreference(WS, "Never use hashtags", []),
    ).resolves.toEqual({
      ok: true,
      saved: false,
      reason: "duplicate",
      rule: "Never use hashtags",
    });
  });
});
