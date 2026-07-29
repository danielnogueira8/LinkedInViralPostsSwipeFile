import { afterEach, describe, test, expect, vi } from "vitest";
import {
  extractCanonicalLinkedInActivityUrn,
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

describe("UrlMatchResolver.resolve — production share/activity identity", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("matches the LeadShark activity record for the same LinkedIn share URL", async () => {
    const shareUrl =
      "https://www.linkedin.com/feed/update/urn:li:share:7488147705668550656/";
    const activityUrn = "urn:li:activity:7488147707111600128";
    const activityUrl =
      "https://www.linkedin.com/posts/andre-nogueira-activity-7488147707111600128";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://apex.leadshark.io/")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                post_id: activityUrn,
                share_url: activityUrl,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === shareUrl) {
        return new Response(
          `<html><head><meta property="lnkd:url" content="https://www.linkedin.com/feed/update/${activityUrn}"></head></html>`,
          { status: 200, headers: { "Content-Type": "text/html" } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal(
      "fetch",
      fetchMock,
    );

    const out = await new UrlMatchResolver().resolve({
      apiKey: "test-key",
      zernioPostUrl: shareUrl,
      zernioPostUrn: "urn:li:share:7488147705668550656",
      urnSnapshot: null,
    });

    expect(out).toEqual({
      kind: "resolved",
      postId: activityUrn,
      shareUrl: activityUrl,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("does not trust a canonical activity URN missing from LeadShark's list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.startsWith("https://apex.leadshark.io/")) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  post_id: "urn:li:activity:9999999999999999999",
                  share_url:
                    "https://www.linkedin.com/posts/someone-activity-9999999999999999999",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          '<meta property="lnkd:url" content="https://www.linkedin.com/feed/update/urn:li:activity:7488147707111600128">',
          { status: 200, headers: { "Content-Type": "text/html" } },
        );
      }),
    );

    const out = await new UrlMatchResolver().resolve({
      apiKey: "test-key",
      zernioPostUrl:
        "https://www.linkedin.com/feed/update/urn:li:share:7488147705668550656/",
      zernioPostUrn: "urn:li:share:7488147705668550656",
      urnSnapshot: null,
    });

    expect(out).toEqual({
      kind: "pending",
      reason: "LeadShark's post list hasn't caught up",
    });
  });

  test("never fetches a non-LinkedIn URL while resolving the canonical identity", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (!url.startsWith("https://apex.leadshark.io/")) {
        throw new Error(`Unexpected outbound fetch: ${url}`);
      }
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await new UrlMatchResolver().resolve({
      apiKey: "test-key",
      zernioPostUrl: "https://example.com/feed/update/urn:li:share:7488147705668550656/",
      zernioPostUrn: "urn:li:share:7488147705668550656",
      urnSnapshot: null,
    });

    expect(out.kind).toBe("pending");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("keeps the existing one-request path when the numeric identity already matches", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              post_id: "urn:li:activity:7488147705668550656",
              share_url:
                "https://www.linkedin.com/posts/andre-nogueira-activity-7488147705668550656",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await new UrlMatchResolver().resolve({
      apiKey: "test-key",
      zernioPostUrl:
        "https://www.linkedin.com/feed/update/urn:li:share:7488147705668550656/",
      zernioPostUrn: "urn:li:share:7488147705668550656",
      urnSnapshot: null,
    });

    expect(out.kind).toBe("resolved");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("extractCanonicalLinkedInActivityUrn", () => {
  test("reads LinkedIn's canonical activity URN from the lnkd:url metadata", () => {
    expect(
      extractCanonicalLinkedInActivityUrn(
        '<meta content="https://www.linkedin.com/feed/update/urn:li:activity:7488147707111600128" property="lnkd:url">',
      ),
    ).toBe("urn:li:activity:7488147707111600128");
  });

  test("ignores activity URNs outside the canonical lnkd:url metadata", () => {
    expect(
      extractCanonicalLinkedInActivityUrn(
        '<a data-comment-urn="urn:li:activity:7488147707111600128">comment</a>',
      ),
    ).toBeNull();
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
