// LeadShark binding — resolving the LinkedIn ACTIVITY URN for a just-published
// post and creating the automation. This is the highest-risk part of the
// integration (see the build plan §6): LeadShark's matcher binds on an exact
// `urn:li:activity:<id>` string, and a wrong/`share` URN silently never fires.
//
// The URN resolution is a STRATEGY SEAM so the two documented paths coexist and
// probe findings can swap the default without a rewrite:
//   - UrlMatchResolver   (§6.3, DEFAULT) — join our permalink against
//     LeadShark's own post list; take LeadShark's post_id (correct by
//     construction — it's already in the matcher's namespace).
//   - SnapshotDiffResolver (§6.4, fallback) — new = current − pre-publish
//     snapshot. Timing-dependent and unrepeatable; only used if URL-match proves
//     unreliable.
//
// Select via LEADSHARK_BINDING_STRATEGY = "url_match" | "snapshot_diff".

import {
  listPosts,
  isActivityUrn,
  type LeadSharkError,
  type LeadSharkPost,
} from "@/lib/leadshark";
import { verifiedLinkedInSourceUrl } from "@/lib/linkedin-url";

// ---------------------------------------------------------------------------
// Numeric-id extraction — the join key. LinkedIn embeds the same post under
// several URL shapes; we compare on the extracted numeric tail, not raw strings.
//   /feed/update/urn:li:share:7483415302685257728/       → 7483415302685257728
//   /feed/update/urn:li:activity:7483415302685257728/    → 7483415302685257728
//   /posts/<slug>-activity-7483415302685257728-abcd      → 7483415302685257728
//   urn:li:activity:7483415302685257728                  → 7483415302685257728
//
// NOTE [PROBE]: a post's `share` id and `activity` id are DIFFERENT numbers, and
// LeadShark's share_url may embed either. `extractPostNumericId` pulls whatever
// tail the string carries; whether our (share-derived) id matches LeadShark's
// (possibly activity-derived) id is exactly what Phase-0 probe item 2 resolves.
// If they differ, we fall back to snapshot-diff. This function is deliberately
// namespace-agnostic so it works for whichever the probe confirms.
// ---------------------------------------------------------------------------

const URN_TAIL_RE = /urn:li:(?:activity|share|ugcPost):(\d{6,})/i;
const ACTIVITY_SLUG_RE = /-activity-(\d{6,})/i;
const BARE_TAIL_RE = /(\d{15,})/; // last-resort: a long numeric run
const CANONICAL_ACTIVITY_URN_RE = /urn:li:activity:(\d{15,20})/i;
const LINKEDIN_CANONICAL_FETCH_TIMEOUT_MS = 8_000;

export function extractPostNumericId(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = String(input);
  const urn = URN_TAIL_RE.exec(s);
  if (urn) return urn[1];
  const slug = ACTIVITY_SLUG_RE.exec(s);
  if (slug) return slug[1];
  const bare = BARE_TAIL_RE.exec(s);
  if (bare) return bare[1];
  return null;
}

/**
 * LinkedIn's public post page publishes the canonical activity identity in a
 * dedicated `lnkd:url` meta tag. Read only that tag: a page can also contain
 * activity URNs for comments or related posts, and accepting an arbitrary
 * occurrence could bind an automation to the wrong post.
 */
export function extractCanonicalLinkedInActivityUrn(html: string): string | null {
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of metaTags) {
    if (!/\bproperty\s*=\s*["']lnkd:url["']/i.test(tag)) continue;
    const match = CANONICAL_ACTIVITY_URN_RE.exec(tag);
    if (match) return `urn:li:activity:${match[1]}`;
  }
  return null;
}

async function fetchCanonicalLinkedInActivityUrn(
  postUrl: string | null,
  signal?: AbortSignal,
): Promise<string | null> {
  const verifiedPostUrl = verifiedLinkedInSourceUrl(postUrl);
  if (!verifiedPostUrl) return null;

  try {
    const timeoutSignal = AbortSignal.timeout(LINKEDIN_CANONICAL_FETCH_TIMEOUT_MS);
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    const response = await fetch(verifiedPostUrl, {
      headers: {
        Accept: "text/html",
        "User-Agent": "Mozilla/5.0 (compatible; SwipeInLeadSharkBinding/1.0)",
      },
      redirect: "follow",
      cache: "no-store",
      signal: requestSignal,
    });
    if (
      !response.ok ||
      !verifiedLinkedInSourceUrl(response.url || verifiedPostUrl)
    ) {
      return null;
    }
    return extractCanonicalLinkedInActivityUrn(await response.text());
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    // LinkedIn's public page is a best-effort identity bridge. A transient
    // fetch failure leaves the bind pending so the background job can retry.
    return null;
  }
}

function postMatchesNumericId(post: LeadSharkPost, numericId: string): boolean {
  return (
    extractPostNumericId(post.shareUrl) === numericId ||
    extractPostNumericId(post.postId) === numericId
  );
}

// ---------------------------------------------------------------------------
// Resolver contract
// ---------------------------------------------------------------------------

// What every resolver needs to do its job. Not every field is used by every
// strategy — url_match needs zernioPostUrl; snapshot_diff needs urnSnapshot.
export type BindingInputs = {
  apiKey: string;
  zernioPostUrl: string | null;
  zernioPostUrn: string | null;
  urnSnapshot: string[] | null;
  signal?: AbortSignal;
};

export type ResolveOutcome =
  // Resolved to exactly one LeadShark post. `postId` is LeadShark's own id
  // (already in the matcher's namespace); `shareUrl` is its permalink.
  | { kind: "resolved"; postId: string; shareUrl: string | null }
  // LeadShark's list hasn't caught up yet — retry later.
  | { kind: "pending"; reason: string }
  // More than one candidate — never guess; the job routes to awaiting_urn.
  | { kind: "ambiguous"; reason: string }
  // A hard upstream error (auth, etc.) — surfaced to the caller.
  | { kind: "error"; error: LeadSharkError };

export interface UrnResolver {
  readonly name: string;
  resolve(inputs: BindingInputs): Promise<ResolveOutcome>;
}

// ---------------------------------------------------------------------------
// §6.3 — URL-match (default). Join our permalink against LeadShark's post list.
// ---------------------------------------------------------------------------

export class UrlMatchResolver implements UrnResolver {
  readonly name = "url_match";

  async resolve(inputs: BindingInputs): Promise<ResolveOutcome> {
    const wantedId = extractPostNumericId(inputs.zernioPostUrl ?? inputs.zernioPostUrn);
    if (!wantedId) {
      // We don't yet have a permalink to match on — the publish response hasn't
      // populated it. Retry; the pre-publish hook / a short poll fills it in.
      return { kind: "pending", reason: "no zernio permalink to match yet" };
    }

    const listed = await listPosts(inputs.apiKey, { signal: inputs.signal });
    if (!listed.ok) return { kind: "error", error: listed.error };

    const directMatches = listed.posts.filter((post) =>
      postMatchesNumericId(post, wantedId),
    );
    if (directMatches.length > 0) return this.fromMatches(directMatches);

    // A LinkedIn share URN and the canonical activity URN for the same post can
    // have DIFFERENT numeric tails. Zernio returns the former; LeadShark lists
    // the latter. Resolve LinkedIn's canonical identity, then still require an
    // exact match in LeadShark's authenticated post list before binding. The
    // public page is never trusted as sufficient evidence on its own.
    const canonicalUrn = await fetchCanonicalLinkedInActivityUrn(
      inputs.zernioPostUrl,
      inputs.signal,
    );
    if (canonicalUrn) {
      const canonicalId = extractPostNumericId(canonicalUrn);
      const canonicalMatches = listed.posts.filter(
        (post) =>
          post.postId === canonicalUrn ||
          (canonicalId !== null && postMatchesNumericId(post, canonicalId)),
      );
      if (canonicalMatches.length > 0) return this.fromMatches(canonicalMatches);
    }

    return this.fromMatches([]);
  }

  // Exposed for direct unit testing without a live list call.
  fromMatches(matches: LeadSharkPost[]): ResolveOutcome {
    if (matches.length === 1) {
      return { kind: "resolved", postId: matches[0].postId, shareUrl: matches[0].shareUrl };
    }
    if (matches.length === 0) {
      return { kind: "pending", reason: "LeadShark's post list hasn't caught up" };
    }
    return { kind: "ambiguous", reason: `${matches.length} candidate posts matched` };
  }
}

// ---------------------------------------------------------------------------
// §6.4 — Snapshot-diff (fallback). new = current − pre-publish snapshot.
// ---------------------------------------------------------------------------

export class SnapshotDiffResolver implements UrnResolver {
  readonly name = "snapshot_diff";

  async resolve(inputs: BindingInputs): Promise<ResolveOutcome> {
    if (!inputs.urnSnapshot) {
      // The pre-publish snapshot is unrepeatable — if it wasn't captured, this
      // path can't run. Caller should fall back to manual paste.
      return { kind: "pending", reason: "no pre-publish snapshot captured" };
    }

    const listed = await listPosts(inputs.apiKey, { signal: inputs.signal });
    if (!listed.ok) return { kind: "error", error: listed.error };

    return this.fromDiff(inputs.urnSnapshot, listed.posts);
  }

  // Exposed for direct unit testing.
  fromDiff(snapshot: string[], current: LeadSharkPost[]): ResolveOutcome {
    const before = new Set(snapshot);
    const fresh = current.filter((p) => !before.has(p.postId));
    if (fresh.length === 1) {
      return { kind: "resolved", postId: fresh[0].postId, shareUrl: fresh[0].shareUrl };
    }
    if (fresh.length === 0) {
      return { kind: "pending", reason: "no new post appeared since the snapshot" };
    }
    return {
      kind: "ambiguous",
      reason: `${fresh.length} new posts since the snapshot (manual post in the window?)`,
    };
  }
}

// ---------------------------------------------------------------------------
// Strategy selection
// ---------------------------------------------------------------------------

export type BindingStrategy = "url_match" | "snapshot_diff";

export function configuredStrategy(): BindingStrategy {
  return process.env.LEADSHARK_BINDING_STRATEGY === "snapshot_diff"
    ? "snapshot_diff"
    : "url_match"; // default per the plan — snapshot-diff is strictly worse
}

export function resolverFor(strategy: BindingStrategy = configuredStrategy()): UrnResolver {
  return strategy === "snapshot_diff" ? new SnapshotDiffResolver() : new UrlMatchResolver();
}

// A final guard used by the job right before sending post_id to LeadShark: even
// a "resolved" outcome must carry a valid ACTIVITY urn, or we refuse to bind.
export function resolvedUrnIsBindable(postId: string): boolean {
  return isActivityUrn(postId);
}
