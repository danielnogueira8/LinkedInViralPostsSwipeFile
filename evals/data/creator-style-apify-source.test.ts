import { describe, test, expect, vi, beforeEach } from "vitest";
import { makeFakeSupabase } from "./fake-supabase";
import type { ScrapedPost } from "@/lib/apify";

// ---------------------------------------------------------------------------
// fetchStyleSourcePosts — the sourceAccountId path now prefers a LIVE Apify
// fetch of the creator's latest ~30 posts, falling back to DB posts when the
// fetch fails or returns too few. These tests drive that decision by mocking
// runProfileHistory + the DB, and assert:
//   - Apify posts (>= MIN) are used, tagged kind:"scraped" with no DB id.
//   - A thin Apify return (< MIN) falls back to DB posts.
//   - An Apify throw falls back to DB posts (no hard failure).
//   - The IDOR guard: an untracked account returns nothing (no fetch at all).
// ---------------------------------------------------------------------------

// Mutable per-test knobs the mocks read.
const state: {
  tracked: string[];
  apify: (() => Promise<ScrapedPost[]>) | null;
  dbPosts: Record<string, unknown>[];
  accountHandle: string | null;
} = { tracked: [], apify: null, dbPosts: [], accountHandle: "creatorhandle" };

vi.mock("@/lib/supabase-scoped", () => ({
  trackedAccountIds: async () => state.tracked,
}));

vi.mock("@/lib/apify", () => ({
  runProfileHistory: (...args: unknown[]) => {
    if (!state.apify) return Promise.resolve([]);
    return state.apify.apply(null, args as []);
  },
}));

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () =>
    makeFakeSupabase({
      accounts: { single: state.accountHandle ? { linkedin_handle: state.accountHandle } : null },
      posts: { rows: state.dbPosts },
    }).client,
}));

const { fetchStyleSourcePosts } = await import("@/lib/agent/creator-style-profile");

function scrapedPost(text: string, reactions: number): ScrapedPost {
  return {
    linkedin_post_id: `urn:${text}`,
    post_url: `https://linkedin.com/${text}`,
    posted_at: null,
    text,
    reactions,
    comments: 0,
    reposts: 0,
    media_type: "none",
    media_urls: [],
    document_manifest_url: null,
    document_page_count: null,
    author_handle: "creatorhandle",
    author_name: "The Creator",
    author_profile_pic_url: null,
    author_headline: null,
  };
}

const ACCT = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  state.tracked = [ACCT];
  state.apify = null;
  state.dbPosts = [];
  state.accountHandle = "creatorhandle";
});

describe("fetchStyleSourcePosts — Apify-first with DB fallback", () => {
  test("uses live Apify posts when it returns enough (>= MIN), tagged 'scraped' with no DB id", async () => {
    // 10 scraped posts (>= the 8-post minimum).
    state.apify = async () =>
      Array.from({ length: 10 }, (_, i) => scrapedPost(`p${i}`, 100 - i));
    state.dbPosts = [{ id: "db-1", text: "db post", post_url: null, reactions: 999 }];

    const out = await fetchStyleSourcePosts({ workspaceId: "ws", sourceAccountId: ACCT });

    expect(out).toHaveLength(10);
    expect(out.every((p) => p.kind === "scraped")).toBe(true);
    expect(out.every((p) => p.id === "")).toBe(true);
    // Best-first by engagement (p0 has the highest reactions).
    expect(out[0].text).toBe("p0");
    // The DB post (reactions 999) must NOT appear — Apify won.
    expect(out.some((p) => p.text === "db post")).toBe(false);
  });

  test("uses ALL 30 fetched posts — no silent truncation to the old 20-post cap", async () => {
    // Apify returns 30 (what we pay for). The analyze cap is now 30, so every
    // post must flow through — this is the regression guard for the bug where a
    // 20-post STYLE_SOURCE_MAX slice threw away 10 posts we'd paid to fetch.
    state.apify = async () =>
      Array.from({ length: 30 }, (_, i) => scrapedPost(`p${String(i).padStart(2, "0")}`, 100 - i));

    const out = await fetchStyleSourcePosts({ workspaceId: "ws", sourceAccountId: ACCT });

    expect(out).toHaveLength(30);
    expect(out.length).toBeGreaterThan(20);
  });

  test("falls back to DB posts when Apify returns too few (< MIN)", async () => {
    state.apify = async () => [scrapedPost("only", 5)]; // 1 < 8
    state.dbPosts = [
      { id: "db-1", text: "db a", post_url: "u1", reactions: 10 },
      { id: "db-2", text: "db b", post_url: "u2", reactions: 5 },
    ];

    const out = await fetchStyleSourcePosts({ workspaceId: "ws", sourceAccountId: ACCT });

    expect(out.map((p) => p.text)).toEqual(["db a", "db b"]);
    expect(out.every((p) => p.kind === "post")).toBe(true);
    expect(out[0].id).toBe("db-1");
  });

  test("falls back to DB posts when Apify throws (no hard failure)", async () => {
    state.apify = async () => {
      throw new Error("apify 500");
    };
    state.dbPosts = [{ id: "db-1", text: "db only", post_url: null, reactions: 1 }];

    const out = await fetchStyleSourcePosts({ workspaceId: "ws", sourceAccountId: ACCT });

    expect(out.map((p) => p.text)).toEqual(["db only"]);
    expect(out[0].kind).toBe("post");
  });

  test("falls back to DB when the account has no linkedin_handle (nothing to fetch)", async () => {
    state.accountHandle = null; // no handle → skip Apify entirely
    state.apify = async () => {
      throw new Error("should not be called");
    };
    state.dbPosts = [{ id: "db-1", text: "db fallback", post_url: null, reactions: 1 }];

    const out = await fetchStyleSourcePosts({ workspaceId: "ws", sourceAccountId: ACCT });

    expect(out.map((p) => p.text)).toEqual(["db fallback"]);
  });

  test("IDOR guard: an untracked account returns nothing and never fetches", async () => {
    state.tracked = []; // ACCT is not tracked by this workspace
    state.apify = async () => {
      throw new Error("should not be called");
    };
    state.dbPosts = [{ id: "db-1", text: "leak", post_url: null, reactions: 1 }];

    const out = await fetchStyleSourcePosts({ workspaceId: "ws", sourceAccountId: ACCT });

    expect(out).toEqual([]);
  });

  test("empty/whitespace scraped posts are dropped before the MIN check", async () => {
    // 9 posts but 3 are blank → 6 usable, which is < 8 → fall back to DB.
    state.apify = async () => [
      ...Array.from({ length: 6 }, (_, i) => scrapedPost(`ok${i}`, 10)),
      scrapedPost("   ", 10),
      { ...scrapedPost("x", 10), text: "" },
      { ...scrapedPost("y", 10), text: null as unknown as string },
    ];
    state.dbPosts = [{ id: "db-1", text: "db wins", post_url: null, reactions: 1 }];

    const out = await fetchStyleSourcePosts({ workspaceId: "ws", sourceAccountId: ACCT });

    expect(out.map((p) => p.text)).toEqual(["db wins"]);
  });
});
