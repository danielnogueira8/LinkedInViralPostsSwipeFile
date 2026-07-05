import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  styleRegenCooldown,
  recoverStaleGeneratingStyle,
  STYLE_REGEN_COOLDOWN_MS,
  STYLE_STALE_GENERATING_MS,
  STYLE_STALE_GENERATING_MESSAGE,
} from "@/lib/creator-styles-cooldown";

// ---------------------------------------------------------------------------
// The regenerate cooldown math + stale-generation recovery — the two guards
// that stop a user from re-spending on styles and un-stick a dead run. Pure /
// hermetic (recovery takes a fake sb with a chainable update()).
// ---------------------------------------------------------------------------

describe("styleRegenCooldown — 30-day gate off the last success", () => {
  test("never generated (null) → always allowed", () => {
    const c = styleRegenCooldown(null);
    expect(c.canRegenerate).toBe(true);
    expect(c.regenAvailableAt).toBeNull();
    expect(c.daysUntilRegen).toBe(0);
  });

  test("just generated → blocked, ~30 days until available", () => {
    const now = Date.now();
    const c = styleRegenCooldown(new Date(now).toISOString());
    expect(c.canRegenerate).toBe(false);
    expect(c.daysUntilRegen).toBeGreaterThan(28);
    expect(c.daysUntilRegen).toBeLessThanOrEqual(30);
    expect(c.regenAvailableAt).not.toBeNull();
  });

  test("generated just over 30 days ago → allowed again", () => {
    const past = new Date(Date.now() - STYLE_REGEN_COOLDOWN_MS - 60_000).toISOString();
    const c = styleRegenCooldown(past);
    expect(c.canRegenerate).toBe(true);
  });

  test("generated 29 days ago → still blocked", () => {
    const past = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString();
    const c = styleRegenCooldown(past);
    expect(c.canRegenerate).toBe(false);
    expect(c.daysUntilRegen).toBeGreaterThanOrEqual(1);
  });
});

// A minimal fake supabase that records the update() chain + resolves, so the
// recovery helper's write can run without a DB.
function fakeSb() {
  const calls: { table: string; patch?: Record<string, unknown>; eqs: unknown[][] } = {
    table: "",
    eqs: [],
  };
  // A chainable, awaitable stub: update()/eq() record + return the builder, and
  // the builder is itself a thenable (resolves to { error: null }) so the
  // recovery helper's `await sb.raw.from(..).update(..).eq(..).eq(..)` settles.
  const builder: Record<string, unknown> = {};
  builder.update = (patch: Record<string, unknown>) => {
    calls.patch = patch;
    return builder;
  };
  builder.eq = (...args: unknown[]) => {
    calls.eqs.push(args);
    return builder;
  };
  builder.then = (onFulfilled: (v: { error: null }) => unknown) =>
    onFulfilled({ error: null });
  const raw = { from: (t: string) => ((calls.table = t), builder) };
  return { sb: { raw, workspaceId: "ws" } as never, calls };
}

// The row shape the recovery helper reads/returns (loose — error appears only
// after a stale flip). Matches GeneratingRowFields plus the written-back error.
type TestRow = {
  status: string;
  generating_started_at: string | null;
  created_at: string;
  error?: string;
};

describe("recoverStaleGeneratingStyle", () => {
  beforeEach(() => vi.restoreAllMocks());

  test("a non-generating row is returned untouched", async () => {
    const { sb } = fakeSb();
    const row = { status: "ready", generating_started_at: null, created_at: "x" };
    expect(await recoverStaleGeneratingStyle(sb, row)).toBe(row);
  });

  test("a fresh generating run (started < ceiling ago) is left alone", async () => {
    const { sb } = fakeSb();
    const row = {
      status: "generating",
      generating_started_at: new Date().toISOString(),
      created_at: "x",
    };
    const out = await recoverStaleGeneratingStyle(sb, row);
    expect(out.status).toBe("generating");
  });

  test("a stale generating run is flipped to failed with the recovery message", async () => {
    const { sb, calls } = fakeSb();
    const stale = new Date(Date.now() - STYLE_STALE_GENERATING_MS - 60_000).toISOString();
    const row: TestRow = { status: "generating", generating_started_at: stale, created_at: "x" };
    const out = await recoverStaleGeneratingStyle(sb, row);
    expect(out.status).toBe("failed");
    expect(out.error).toBe(STYLE_STALE_GENERATING_MESSAGE);
    // The write was scoped to still-'generating' rows (compare-and-swap safety).
    expect(calls.table).toBe("creator_style_profiles");
    expect(calls.patch?.status).toBe("failed");
    expect(calls.eqs.some(([col, val]) => col === "status" && val === "generating")).toBe(true);
  });

  test("an old generating row with no generating_started_at falls back to created_at", async () => {
    const { sb } = fakeSb();
    const stale = new Date(Date.now() - STYLE_STALE_GENERATING_MS - 60_000).toISOString();
    const row: TestRow = { status: "generating", generating_started_at: null, created_at: stale };
    const out = await recoverStaleGeneratingStyle(sb, row);
    expect(out.status).toBe("failed");
  });

  test("null row is a passthrough", async () => {
    const { sb } = fakeSb();
    expect(await recoverStaleGeneratingStyle(sb, null)).toBeNull();
  });
});
