import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyPost } from "@/lib/post-type";
import { planPostTypeBackfill } from "@/lib/post-type-backfill";

// ---------------------------------------------------------------------------
// Giveaway-first lead magnets.
//
// The original patterns all assumed the post named a MECHANISM — comment this
// keyword, DM me that word. Creators increasingly just announce the giveaway
// and point down: "Get free access below 👇", "I'm giving away the full course
// for free". Those classified as regular posts.
//
// That is not cosmetic. post_type picks which discovery threshold applies —
// lead magnets qualify on comments, regular posts on likes — so a misclassified
// lead magnet is measured on the axis it deliberately suppresses, and drops out
// of the swipe file. It also decides whether the comment-to-DM automation is
// offered at all.
//
// The false-positive half matters just as much: "free speech", "giving away the
// ending". A regular post misread as a lead magnet gets judged on comments it
// was never trying to earn.
// ---------------------------------------------------------------------------

function isLeadMagnet(text: string): boolean {
  return classifyPost(text).post_type === "lead_magnet";
}

describe("giveaway CTAs with no keyword mechanism", () => {
  // Verbatim from the report — each one classified as a regular post before.
  const REPORTED = [
    "Get free access below 👇",
    "I'm giving away",
    "Free access.",
    "I'm giving away the full course for free.",
    "free access below..",
  ];

  it.each(REPORTED)("detects %j", (text) => {
    expect(isLeadMagnet(text)).toBe(true);
  });

  it("detects the uncontracted delivery promise", () => {
    // "I'll send you" already matched; "I will send you" did not, purely
    // because the pattern hard-coded the contraction.
    expect(isLeadMagnet("I will send you the link if you comment.")).toBe(true);
    expect(isLeadMagnet("I'll send you the link if you comment.")).toBe(true);
  });

  it("detects first-person giveaways", () => {
    expect(isLeadMagnet("We're giving away our entire prompt library.")).toBe(true);
    expect(isLeadMagnet("I am giving it away to anyone who wants it.")).toBe(true);
    expect(isLeadMagnet("I'll be giving away my SOPs this week.")).toBe(true);
  });

  it("detects free-resource offers", () => {
    expect(isLeadMagnet("Free playbook for anyone who wants it.")).toBe(true);
    expect(isLeadMagnet("Grab it for free 👇")).toBe(true);
    expect(isLeadMagnet("Download yours for free.")).toBe(true);
    expect(isLeadMagnet("Complimentary audit for the first ten people.")).toBe(true);
    expect(isLeadMagnet("Sharing it for free below.")).toBe(true);
  });
});

describe("ordinary English is still a regular post", () => {
  // Each of these tripped an earlier, looser draft of these patterns. They are
  // the reason "giving away" requires a resource object and "free" requires a
  // resource noun.
  const REGULAR = [
    "Free speech matters more than ever in this industry.",
    "That's giving away the ending, so I won't spoil it.",
    "He kept giving away his age with those references.",
    "Feel free to disagree with me on this one.",
    "The course was free when I took it back in 2019.",
    "I got free advice from a mentor and it changed everything.",
    "We are giving our customers a better experience.",
    "Free yourself from the meeting treadmill.",
    "Giving away the game early is how negotiations get lost.",
    "It was a free-for-all in the comments yesterday.",
  ];

  it.each(REGULAR)("leaves %j alone", (text) => {
    expect(isLeadMagnet(text)).toBe(false);
  });
});

describe("the original patterns still hold", () => {
  // A regression here would be invisible in the new cases above.
  it("keyword mechanisms", () => {
    expect(isLeadMagnet(`Comment "PLAYBOOK" and I'll DM you the doc.`)).toBe(true);
    expect(isLeadMagnet("Comment SYSTEM below for the breakdown.")).toBe(true);
    expect(isLeadMagnet("Want the template? Comment below.")).toBe(true);
  });

  it("and their guards", () => {
    expect(isLeadMagnet("Drop ONE thing you'd change about your funnel.")).toBe(false);
    expect(isLeadMagnet("Drop the act. We both know what happened.")).toBe(false);
    expect(isLeadMagnet("Comment on this if you've seen it before.")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Backfill: post_type is stamped once at ingest, so widening the patterns only
// helps posts scraped afterwards unless the back catalogue is re-run.
// ---------------------------------------------------------------------------
describe("the backfill plan", () => {
  it("promotes a post the widened patterns now catch", () => {
    const plan = planPostTypeBackfill([
      { id: "a", text: "Get free access below 👇", post_type: "regular" },
    ]);
    expect(plan.promote).toEqual(["a"]);
    expect(plan.demote).toEqual([]);
  });

  it("leaves an already-correct post alone", () => {
    const plan = planPostTypeBackfill([
      { id: "b", text: "Comment SYSTEM for the breakdown.", post_type: "lead_magnet" },
      { id: "c", text: "Free speech matters.", post_type: "regular" },
    ]);
    expect(plan.unchanged).toBe(2);
    expect(plan.promote).toEqual([]);
  });

  it("separates demotions rather than lumping them in", () => {
    // The patterns only ever widened, so a stored lead_magnet the classifier
    // no longer recognises was set by something else — a human, or the
    // giveaway attachment. Not ours to overwrite.
    const plan = planPostTypeBackfill([
      { id: "d", text: "Just some thoughts on hiring.", post_type: "lead_magnet" },
    ]);
    expect(plan.demote).toEqual(["d"]);
    expect(plan.promote).toEqual([]);
  });

  it("treats a null stored type as nothing to correct", () => {
    const plan = planPostTypeBackfill([
      { id: "e", text: "Just some thoughts on hiring.", post_type: null },
    ]);
    expect(plan.unchanged).toBe(1);
    expect(plan.promote).toEqual([]);
    expect(plan.demote).toEqual([]);
  });
});

describe("backfill script safety", () => {
  const SCRIPT = readFileSync(
    path.join(process.cwd(), "scripts/backfill-post-type.ts"),
    "utf8",
  );

  function code(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
  }

  it("writes nothing without --apply", () => {
    const body = code(SCRIPT);
    const guardAt = body.indexOf("if (!apply)");
    const writeAt = body.indexOf(".update(");
    expect(guardAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(guardAt);
  });

  it("keeps demotions behind a second flag", () => {
    expect(code(SCRIPT)).toContain("if (includeDemotions) writes.push(");
  });
});
