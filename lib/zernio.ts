// Zernio API client — schedules + publishes LinkedIn posts.
//
// One PLATFORM key (ZERNIO_API_KEY, server-only) — SwipeIn pays Zernio; users
// never see it. Mirrors lib/apify.ts / lib/openrouter.ts (env token getter,
// bounded retry, structured error + usage logging).
//
// The per-workspace thing is the Zernio `accountId` (from each user's LinkedIn
// OAuth), stored in publishing_connections and resolved server-side from the
// caller's workspace_id — NEVER from client input (a client-supplied accountId
// would be a post-to-someone-else's-LinkedIn IDOR).
//
// Docs: https://docs.zernio.com  ·  Base: https://zernio.com/api/v1

import { fetchWithRetry } from "./openrouter";
import { supabaseAdmin } from "./supabase";
import type { PostMediaType } from "./post-media";

const BASE_URL = "https://zernio.com/api/v1";

// LinkedIn's hard caption cap. Enforce at schedule AND publish time — note our
// draft body cap (MAX_DRAFT_BODY in lib/batch/weekly.ts) is 3,200, so a legal
// draft can exceed LinkedIn's limit; callers must reject over-length bodies.
export const LINKEDIN_MAX_CHARS = 3000;

function apiKey(): string {
  const k = process.env.ZERNIO_API_KEY;
  if (!k) throw new Error("ZERNIO_API_KEY not set");
  return k;
}

// ---------------------------------------------------------------------------
// Error mapping — Zernio/LinkedIn have a ~9.5% failure rate with a handful of
// recurring, distinctly-handled failures. Map an HTTP failure to a typed kind
// so callers know whether to retry (transient) vs. give up (duplicate) vs. flip
// the connection to disconnected (token_expired). See the Zernio error table.
// ---------------------------------------------------------------------------
export type ZernioErrorKind =
  | "duplicate" // 422: LinkedIn rejected identical/near-identical content — PERMANENT, never retry
  | "token_expired" // OAuth token revoked/expired — reconnect the account
  | "preflight" // rate-limit / validation caught pre-publish — transient-ish
  | "transient" // max-retries / temporary — safe to retry later
  | "other";

export type ZernioError = { kind: ZernioErrorKind; message: string; status: number };

export function mapZernioError(status: number, bodyText: string): ZernioError {
  const b = (bodyText || "").toLowerCase();
  if (status === 422 || b.includes("duplicate")) {
    return {
      kind: "duplicate",
      status,
      message:
        "LinkedIn rejected this as a duplicate of an earlier post. Change the wording meaningfully and try again.",
    };
  }
  if (status === 401 || b.includes("token") || b.includes("expired") || b.includes("revoked")) {
    return {
      kind: "token_expired",
      status,
      message: "Your LinkedIn connection expired. Reconnect it in Settings, then reschedule.",
    };
  }
  if (b.includes("preflight")) {
    return {
      kind: "preflight",
      status,
      message: "LinkedIn rejected this during preflight checks. Space your posts further apart and try again.",
    };
  }
  if (b.includes("max retries")) {
    return {
      kind: "transient",
      status,
      message: "Publishing failed after several attempts. This is usually temporary — try again shortly.",
    };
  }
  return {
    kind: status >= 500 ? "transient" : "other",
    status,
    message: `Publishing failed (${status}). Please try again.`,
  };
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------
export type CreatePostResult =
  | { ok: true; postId: string | null }
  | { ok: false; error: ZernioError };

// Publish a text post to LinkedIn NOW via Zernio. `accountId` MUST come from the
// caller's own publishing_connections row (never the client). `firstComment`
// (optional) auto-posts after publish — put external links here, not in the
// body, to dodge LinkedIn's ~40-50% link-suppression penalty.
//
// fetchWithRetry retries connection-phase + transient statuses only and never
// replays a 4xx — so a 422 duplicate is surfaced once, not re-posted. On !ok we
// return a typed error the caller maps to UI + connection state.
export async function createLinkedInPost(opts: {
  accountId: string;
  content: string;
  requestId?: string;
  firstComment?: string | null;
  mediaItems?: Array<{ url: string; type: PostMediaType }>;
}): Promise<CreatePostResult> {
  const platformSpecificData: Record<string, unknown> = {};
  if (opts.firstComment && opts.firstComment.trim()) {
    platformSpecificData.firstComment = opts.firstComment.trim();
  }
  const body = {
    content: opts.content,
    ...(opts.mediaItems?.length ? { mediaItems: opts.mediaItems } : {}),
    platforms: [
      {
        platform: "linkedin",
        accountId: opts.accountId,
        ...(Object.keys(platformSpecificData).length ? { platformSpecificData } : {}),
      },
    ],
    publishNow: true,
  };

  let res: Response;
  try {
    res = await fetchWithRetry(
      `${BASE_URL}/posts`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey()}`,
          "Content-Type": "application/json",
          ...(opts.requestId ? { "x-request-id": opts.requestId } : {}),
        },
        body: JSON.stringify(body),
      },
      "zernio_create_post",
    );
  } catch (e) {
    // Network error after retries exhausted — treat as transient (retryable).
    return {
      ok: false,
      error: { kind: "transient", status: 0, message: (e as Error).message },
    };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: mapZernioError(res.status, text) };
  }

  // A same-request replay returns the original row as `existingPost`.
  const data = (await res.json().catch(() => ({}))) as {
    post?: { _id?: string };
    existingPost?: { _id?: string };
  };
  return {
    ok: true,
    postId: data.post?._id ?? data.existingPost?._id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Media uploads
// ---------------------------------------------------------------------------
export type ZernioPresignResult = {
  uploadUrl: string;
  publicUrl: string;
  key: string | null;
  expiresIn: number | null;
};

export async function getMediaPresignedUrl(opts: {
  filename: string;
  contentType: string;
}): Promise<ZernioPresignResult> {
  const res = await fetchWithRetry(
    `${BASE_URL}/media/presign`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filename: opts.filename,
        contentType: opts.contentType,
      }),
    },
    "zernio_media_presign",
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(mapZernioError(res.status, text).message);
  }
  const data = (await res.json().catch(() => ({}))) as {
    uploadUrl?: string;
    publicUrl?: string;
    key?: string;
    expiresIn?: number;
  };
  if (!data.uploadUrl || !data.publicUrl) {
    throw new Error("Zernio did not return a media upload URL.");
  }
  return {
    uploadUrl: data.uploadUrl,
    publicUrl: data.publicUrl,
    key: data.key ?? null,
    expiresIn: typeof data.expiresIn === "number" ? data.expiresIn : null,
  };
}

export async function uploadToPresignedUrl(opts: {
  uploadUrl: string;
  contentType: string;
  body: BodyInit;
}): Promise<void> {
  const upload = await fetch(opts.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": opts.contentType },
    body: opts.body,
  });
  if (!upload.ok) {
    const text = await upload.text().catch(() => "");
    throw new Error(mapZernioError(upload.status, text).message);
  }
}

// ---------------------------------------------------------------------------
// Accounts (connect flow) — list the Zernio accounts on the platform key. Used
// to identify a workspace's newly-connected LinkedIn account after OAuth.
// NOTE: adapt the exact connect endpoints to Zernio's connecting-accounts guide
// (docs.zernio.com/guides/connecting-accounts) — this covers the listing side.
// ---------------------------------------------------------------------------
// Fields per the OpenAPI /v1/accounts schema: the id is `_id` (NOT `id`),
// plus platform / displayName / profileUrl / isActive. There is no avatar or
// personal-vs-organization field in the documented response, so we don't invent
// them (avatar stays null; account_type defaults to 'personal' at the DB).
export type ZernioAccount = {
  id: string; // Zernio's `_id`
  platform: string;
  displayName: string | null;
  profileUrl: string | null;
  isActive: boolean;
};

function shared(): { headers: Record<string, string> } {
  return {
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
  };
}

// GET /v1/accounts — the connections on the platform key, optionally scoped to a
// Zernio profile (a workspace's container). We use this as the source of truth
// for identifying a newly-connected LinkedIn account after the hosted OAuth
// finishes (the callback itself doesn't hand back the account id).
export async function listAccounts(profileId?: string): Promise<ZernioAccount[]> {
  const qs = profileId ? `?profileId=${encodeURIComponent(profileId)}` : "";
  const res = await fetchWithRetry(
    `${BASE_URL}/accounts${qs}`,
    { method: "GET", ...shared() },
    "zernio_list_accounts",
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(mapZernioError(res.status, text).message);
  }
  const data = (await res.json().catch(() => ({}))) as {
    accounts?: Array<Record<string, unknown>>;
  };
  const rows = Array.isArray(data.accounts) ? data.accounts : [];
  return rows.map((a) => ({
    id: String(a._id ?? ""),
    platform: String(a.platform ?? ""),
    displayName: (a.displayName as string) ?? null,
    profileUrl: (a.profileUrl as string) ?? null,
    isActive: a.isActive !== false,
  }));
}

// POST /v1/profiles — create a Zernio "profile" (a per-workspace container that
// accounts connect into). Returns its id. We create one per workspace on first
// connect and reuse it, so a workspace's LinkedIn account is isolated on
// Zernio's side. (Response id field is `id` per the OpenAPI create-profile op.)
export async function createProfile(name: string): Promise<string> {
  const res = await fetchWithRetry(
    `${BASE_URL}/profiles`,
    { method: "POST", ...shared(), body: JSON.stringify({ name }) },
    "zernio_create_profile",
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(mapZernioError(res.status, text).message);
  }
  const data = (await res.json().catch(() => ({}))) as {
    id?: string;
    profile?: { id?: string; _id?: string };
    _id?: string;
  };
  const id = data.id ?? data.profile?.id ?? data.profile?._id ?? data._id ?? "";
  if (!id) throw new Error("Zernio did not return a profile id.");
  return String(id);
}

// GET /v1/connect/{platform}?profileId=&redirectUrl= — start the hosted OAuth
// flow. Returns the authUrl to redirect the user to. After they finish, Zernio
// bounces back to redirectUrl; we then reconcile via listAccounts(profileId).
export async function getConnectUrl(opts: {
  platform: "linkedin";
  profileId: string;
  redirectUrl: string;
}): Promise<string> {
  const qs = new URLSearchParams({
    profileId: opts.profileId,
    redirectUrl: opts.redirectUrl,
  }).toString();
  const res = await fetchWithRetry(
    `${BASE_URL}/connect/${opts.platform}?${qs}`,
    { method: "GET", ...shared() },
    "zernio_get_connect_url",
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(mapZernioError(res.status, text).message);
  }
  const data = (await res.json().catch(() => ({}))) as { authUrl?: string };
  if (!data.authUrl) throw new Error("Zernio did not return an auth URL.");
  return data.authUrl;
}

// DELETE /v1/accounts/{id} — disconnect an account on Zernio's side. Best-effort
// (we still mark our row disconnected regardless); returns whether it succeeded.
export async function deleteAccount(accountId: string): Promise<boolean> {
  try {
    const res = await fetchWithRetry(
      `${BASE_URL}/accounts/${encodeURIComponent(accountId)}`,
      { method: "DELETE", ...shared() },
      "zernio_delete_account",
    );
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Usage — one workspace-scoped usage_events row per publish so the daily digest
// sees publish activity. Zernio's per-post price isn't in the docs, so cost is
// logged as 0 for now (units:1 = one published post); revisit when pricing /
// analytics land (Phase 2). Best-effort — a failed log never breaks a publish.
// ---------------------------------------------------------------------------
export async function logZernioUsage(
  kind: string,
  workspaceId: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  try {
    await supabaseAdmin().from("usage_events").insert({
      provider: "zernio",
      kind,
      units: 1,
      cost_usd: 0,
      workspace_id: workspaceId,
      meta: meta ?? null,
    });
  } catch (e) {
    console.error("zernio usage log fail", (e as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Analytics — per-post LinkedIn metrics for posts Zernio published.
// GET /v1/analytics?platform=linkedin&fromDate=&toDate= → { posts: [...] }.
// The per-item shape isn't pinned by the docs, so parsing is DEFENSIVE:
// the post id and each metric are looked up under the plausible key variants
// and coerced; anything unrecognized survives in `raw` for later backfill.
// ---------------------------------------------------------------------------
export type ZernioPostAnalytics = {
  postId: string;
  impressions: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  sends: number | null;
  videoViews: number | null;
  raw: Record<string, unknown>;
};

function pickNumber(o: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  // Metrics may sit one level down under a `metrics`/`analytics` object.
  for (const nest of ["metrics", "analytics", "stats"]) {
    const inner = o[nest];
    if (inner && typeof inner === "object") {
      for (const k of keys) {
        const v = (inner as Record<string, unknown>)[k];
        if (typeof v === "number" && Number.isFinite(v)) return v;
      }
    }
  }
  return null;
}

// Pure + exported for unit tests.
export function parseZernioAnalyticsPosts(payload: unknown): ZernioPostAnalytics[] {
  if (!payload || typeof payload !== "object") return [];
  const posts = (payload as { posts?: unknown }).posts;
  if (!Array.isArray(posts)) return [];
  const out: ZernioPostAnalytics[] = [];
  for (const p of posts) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    // Field precedence matters. Zernio's /analytics returns a DIFFERENT `_id`
    // (its own analytics-record id) than the `post._id` createLinkedInPost
    // returned at publish time — which we stored as zernio_post_id. The original
    // publish id comes back on the analytics row as `latePostId`, so it MUST be
    // tried before `_id`; otherwise we'd match on the wrong `_id` and the join to
    // our artifacts never connects (the "reported>0 but matched=0" bug).
    const postId =
      typeof o.postId === "string"
        ? o.postId
        : typeof o.latePostId === "string"
          ? o.latePostId
          : typeof o._id === "string"
            ? o._id
            : typeof o.id === "string"
              ? o.id
              : null;
    if (!postId) continue;
    out.push({
      postId,
      impressions: pickNumber(o, ["impressions"]),
      reach: pickNumber(o, ["reach", "membersReached", "uniqueImpressions"]),
      likes: pickNumber(o, ["likes", "reactions"]),
      comments: pickNumber(o, ["comments"]),
      shares: pickNumber(o, ["shares", "reposts"]),
      saves: pickNumber(o, ["saves"]),
      sends: pickNumber(o, ["sends"]),
      videoViews: pickNumber(o, ["views", "videoViews"]),
      raw: o,
    });
  }
  return out;
}

// Fetch LinkedIn analytics for all posts published under this API key in the
// date range. Throws on transport/API failure — the caller (cron refresh)
// treats analytics as best-effort and must not fail the cron on it.
export async function getLinkedInAnalytics(opts: {
  fromDate: string; // YYYY-MM-DD
  toDate: string; // YYYY-MM-DD
}): Promise<ZernioPostAnalytics[]> {
  const url = `${BASE_URL}/analytics?platform=linkedin&fromDate=${encodeURIComponent(
    opts.fromDate,
  )}&toDate=${encodeURIComponent(opts.toDate)}`;
  const res = await fetchWithRetry(
    url,
    { method: "GET", headers: { Authorization: `Bearer ${apiKey()}` } },
    "zernio_analytics",
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Zernio analytics ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = (await res.json().catch(() => ({}))) as unknown;
  return parseZernioAnalyticsPosts(data);
}
