import { describe, test, expect } from "vitest";
import {
  extractPostNumericId,
  UrlMatchResolver,
  SnapshotDiffResolver,
  resolverFor,
  resolvedUrnIsBindable,
  type BindingStrategy,
} from "@/lib/leadshark-binding";
import type { LeadSharkPost } from "@/lib/leadshark";

// ---------------------------------------------------------------------------
// The binding strategy seam (build plan §6). These are pure functions — the two
// resolvers' matching/diff logic and the numeric-id normalizer that joins the
// URL shapes. The live list() call is not exercised here; fromMatches/fromDiff
// are tested directly.
// ---------------------------------------------------------------------------

function post(p: Partial<LeadSharkPost> & { postId: string }): LeadSharkPost {
  return { shareUrl: null, raw: null, ...p };
}

describe("extractPostNumericId — the join key across URL shapes", () => {
  test("pulls the tail from a share URN feed URL", () => {
    expect(
      extractPostNumericId(
        "https://www.linkedin.com/feed/update/urn:li:share:7483415302685257728/",
      ),
    ).toBe("7483415302685257728");
  });

  test("pulls the tail from an activity URN feed URL", () => {
    expect(
      extractPostNumericId(
        "https://www.linkedin.com/feed/update/urn:li:activity:7483415302685257728/",
      ),
    ).toBe("7483415302685257728");
  });

  test("pulls the activity id from a /posts/<slug>-activity-<id>-<hash> URL", () => {
    expect(
      extractPostNumericId(
        "https://www.linkedin.com/posts/daniel-nogueira_playbook-activity-7483415302685257728-abcd",
      ),
    ).toBe("7483415302685257728");
  });

  test("pulls the tail from a bare URN", () => {
    expect(extractPostNumericId("urn:li:activity:7483415302685257728")).toBe(
      "7483415302685257728",
    );
  });

  test("returns null for empty / non-matching input", () => {
    expect(extractPostNumericId(null)).toBeNull();
    expect(extractPostNumericId("")).toBeNull();
    expect(extractPostNumericId("https://example.com/no-id-here")).toBeNull();
  });
});

describe("UrlMatchResolver.fromMatches (§6.3)", () => {
  const r = new UrlMatchResolver();

  test("exactly one match → resolved, takes LeadShark's post_id + share_url", () => {
    const out = r.fromMatches([
      post({ postId: "urn:li:activity:111", shareUrl: "https://li/posts/x-activity-111-z" }),
    ]);
    expect(out).toEqual({
      kind: "resolved",
      postId: "urn:li:activity:111",
      shareUrl: "https://li/posts/x-activity-111-z",
    });
  });

  test("zero matches → pending (list hasn't caught up, retry)", () => {
    expect(r.fromMatches([]).kind).toBe("pending");
  });

  test("more than one match → ambiguous (never guess)", () => {
    const out = r.fromMatches([
      post({ postId: "urn:li:activity:111" }),
      post({ postId: "urn:li:activity:222" }),
    ]);
    expect(out.kind).toBe("ambiguous");
  });
});

describe("SnapshotDiffResolver.fromDiff (§6.4)", () => {
  const r = new SnapshotDiffResolver();

  test("exactly one new post since the snapshot → resolved", () => {
    const snapshot = ["urn:li:activity:100", "urn:li:activity:200"];
    const current = [
      post({ postId: "urn:li:activity:100" }),
      post({ postId: "urn:li:activity:200" }),
      post({ postId: "urn:li:activity:300", shareUrl: "u3" }),
    ];
    expect(r.fromDiff(snapshot, current)).toEqual({
      kind: "resolved",
      postId: "urn:li:activity:300",
      shareUrl: "u3",
    });
  });

  test("no new post → pending", () => {
    const snapshot = ["urn:li:activity:100"];
    expect(r.fromDiff(snapshot, [post({ postId: "urn:li:activity:100" })]).kind).toBe(
      "pending",
    );
  });

  test("more than one new post → ambiguous (a manual post landed in the window)", () => {
    const snapshot = ["urn:li:activity:100"];
    const current = [
      post({ postId: "urn:li:activity:100" }),
      post({ postId: "urn:li:activity:300" }),
      post({ postId: "urn:li:activity:400" }),
    ];
    expect(r.fromDiff(snapshot, current).kind).toBe("ambiguous");
  });
});

describe("strategy selection + bindable guard", () => {
  test("default strategy is url_match", () => {
    // resolverFor() with no arg reads env; explicitly pass to be deterministic.
    expect(resolverFor("url_match").name).toBe("url_match");
    expect(resolverFor("snapshot_diff").name).toBe("snapshot_diff");
  });

  test("configuredStrategy type is respected", () => {
    const strategies: BindingStrategy[] = ["url_match", "snapshot_diff"];
    for (const s of strategies) expect(resolverFor(s).name).toBe(s);
  });

  test("resolvedUrnIsBindable only accepts an activity URN", () => {
    expect(resolvedUrnIsBindable("urn:li:activity:123")).toBe(true);
    // A share URN that leaked into a 'resolved' outcome is still refused.
    expect(resolvedUrnIsBindable("urn:li:share:123")).toBe(false);
    expect(resolvedUrnIsBindable("123")).toBe(false);
  });
});
