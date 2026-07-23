import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  isLeadMagnetPostType,
  leadMagnetPostIds,
  opportunityIsLeadMagnet,
  opportunitySourcePostIds,
} from "@/lib/agent-loop/opportunity-post-type";

const ROOT = process.cwd();
const BRIEFING_ROUTE = path.join(ROOT, "app/api/agent/briefing/route.ts");
const BRIEFING_UI = path.join(ROOT, "app/(app)/dashboard/agent-briefing.tsx");

describe("opportunity source post type", () => {
  it("only treats the persisted 'lead_magnet' value as a lead magnet", () => {
    expect(isLeadMagnetPostType("lead_magnet")).toBe(true);
    expect(isLeadMagnetPostType("regular")).toBe(false);
    // No heuristics, no coercion: anything else is not a lead magnet.
    expect(isLeadMagnetPostType(null)).toBe(false);
    expect(isLeadMagnetPostType(undefined)).toBe(false);
    expect(isLeadMagnetPostType(true)).toBe(false);
    expect(isLeadMagnetPostType("LEAD_MAGNET")).toBe(false);
    expect(isLeadMagnetPostType("lead magnet")).toBe(false);
  });

  it("indexes only lead-magnet rows with a usable id", () => {
    const ids = leadMagnetPostIds([
      { id: "a", post_type: "lead_magnet" },
      { id: "b", post_type: "regular" },
      { id: 42, post_type: "lead_magnet" },
      { post_type: "lead_magnet" },
      { id: "c", post_type: "lead_magnet" },
    ]);
    expect([...ids].sort()).toEqual(["a", "c"]);
  });

  it("survives an empty or missing posts result", () => {
    expect(leadMagnetPostIds([]).size).toBe(0);
    expect(leadMagnetPostIds(null).size).toBe(0);
    expect(leadMagnetPostIds(undefined).size).toBe(0);
  });

  it("collects distinct source post ids and skips null ones", () => {
    // source_post_id is ON DELETE SET NULL, so nulls are expected in the wild.
    expect(
      opportunitySourcePostIds([
        { source_post_id: "p1" },
        { source_post_id: null },
        { source_post_id: "p1" },
        {},
        { source_post_id: "p2" },
      ]).sort(),
    ).toEqual(["p1", "p2"]);
    expect(opportunitySourcePostIds(null)).toEqual([]);
  });

  it("flags an opportunity only when its source post is a lead magnet", () => {
    const leadMagnets = new Set(["p1"]);
    expect(opportunityIsLeadMagnet({ source_post_id: "p1" }, leadMagnets)).toBe(true);
    expect(opportunityIsLeadMagnet({ source_post_id: "p2" }, leadMagnets)).toBe(false);
    // Deleted source post => no badge rather than a wrong badge.
    expect(opportunityIsLeadMagnet({ source_post_id: null }, leadMagnets)).toBe(false);
    expect(opportunityIsLeadMagnet(null, leadMagnets)).toBe(false);
    expect(opportunityIsLeadMagnet({ source_post_id: "p1" }, new Set())).toBe(false);
  });

  it("end-to-end: posts rows + opportunity rows resolve to per-card flags", () => {
    const opportunities = [
      { id: "o1", source_post_id: "p1" },
      { id: "o2", source_post_id: "p2" },
      { id: "o3", source_post_id: null },
    ];
    const posts = [
      { id: "p1", post_type: "lead_magnet" },
      { id: "p2", post_type: "regular" },
    ];
    const ids = opportunitySourcePostIds(opportunities);
    expect(ids.sort()).toEqual(["p1", "p2"]);
    const leadMagnets = leadMagnetPostIds(posts);
    expect(
      opportunities.map((o) => opportunityIsLeadMagnet(o, leadMagnets)),
    ).toEqual([true, false, false]);
  });
});

describe("briefing route exposes the flag", () => {
  const src = readFileSync(BRIEFING_ROUTE, "utf8");

  it("selects source_post_id so the post type can be resolved", () => {
    expect(src).toMatch(/from\("agent_opportunities"\)[\s\S]*?source_post_id/);
  });

  it("reads post_type from posts, not from a re-classification of the text", () => {
    expect(src).toContain('.from("posts")');
    // The shared swipe-card selection contains persisted post_type; it is
    // never re-derived from the post text.
    expect(src).toContain("SWIPE_POST_COLS");
    expect(src).not.toContain("classifyPost");
  });

  it("returns is_lead_magnet on every opportunity", () => {
    expect(src).toContain("is_lead_magnet: opportunityIsLeadMagnet(");
  });
});

describe("working now card badge", () => {
  const src = readFileSync(BRIEFING_UI, "utf8");

  it("renders the badge only when the flag is true", () => {
    expect(src).toContain("{opportunity.is_lead_magnet ? (");
    expect(src).toContain("<LeadMagnetBadge");
  });

  it("is reachable and described without hover", () => {
    // Keyboard focusable...
    expect(src).toContain("tabIndex={0}");
    // ...labelled for screen readers...
    expect(src).toContain('aria-label="Lead magnet post"');
    expect(src).toContain("aria-describedby={hintId}");
    expect(src).toContain('role="tooltip"');
    // ...and revealed on focus, not hover alone.
    expect(src).toContain("peer-focus-visible:opacity-100");
    expect(src).toContain("peer-hover:opacity-100");
  });

  it("gives each card a unique hint id", () => {
    expect(src).toContain("`agent-briefing-lead-magnet-${opportunity.id}`");
  });

  it("does not break the card's action layout", () => {
    expect(src).toContain('<span className="relative shrink-0">');
    expect(src).toContain("footerActions={");
  });

  it("does not pull in a new tooltip dependency", () => {
    expect(src).not.toMatch(/@radix-ui|react-tooltip|@floating-ui/);
  });
});
