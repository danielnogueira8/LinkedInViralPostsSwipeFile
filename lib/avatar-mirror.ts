import { supabaseAdmin } from "./supabase";

// ---------------------------------------------------------------------------
// Mirroring profile avatars into storage we own.
//
// LinkedIn CDN avatar URLs are time-limited: they expire after days or weeks.
// A workspace's own voice_profiles.avatar_url is written once at voice
// generation and never refreshed, so it always rots eventually and the UI
// falls back to the Clerk photo or to initials. (Tracked creators avoid this
// only because lib/pipeline.ts re-scrapes them; nothing re-scrapes you.)
//
// So copy the bytes once, at the moment we are handed a URL that still works,
// and store our own durable URL instead. Nothing to refresh, nothing to expire.
//
// EVERY failure returns null and the caller keeps the provider URL. A mirror
// that cannot run must never cost someone their voice profile — an expiring
// avatar is a far smaller problem than a failed generation, and the render
// path already handles an expired URL.
// ---------------------------------------------------------------------------

export const AVATAR_BUCKET = "profile-avatars";

// LinkedIn serves member photos from these hosts. The URL reaching this module
// came from a scraper, i.e. from remote content, and we are about to make the
// SERVER fetch it — so it is an SSRF sink, not merely a display string. An
// allowlist is the control: without it a crafted profile payload could aim this
// fetch at a cloud metadata endpoint or an internal address. Suffix-matched
// against the parsed hostname (never a substring test on the raw URL, which
// "evil.com/media.licdn.com" would satisfy).
const ALLOWED_AVATAR_HOSTS = [
  "licdn.com",
  "media.licdn.com",
  "static.licdn.com",
];

// Profile photos are small. This bounds what one call can pull into memory and
// caps what a hostile response can spend, independent of Content-Length (which
// a server can lie about or omit — enforced again on the real bytes below).
export const AVATAR_MAX_BYTES = 4 * 1024 * 1024;

const AVATAR_FETCH_TIMEOUT_MS = 8_000;

const ALLOWED_AVATAR_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

/**
 * Is this a URL we are willing to make the server fetch?
 * https only (an http fetch would be downgraded and is never needed here) and
 * a hostname inside the allowlist. Exported for tests.
 */
export function isMirrorableAvatarUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return ALLOWED_AVATAR_HOSTS.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}

/**
 * Storage path for a workspace's avatar.
 *
 * Keyed by workspace so one workspace can never overwrite another's, and
 * stable so re-running generation replaces the image in place rather than
 * accumulating an orphan per run. `version` busts any CDN cache on the public
 * URL — without it a replaced image keeps serving the previous bytes.
 */
export function avatarStoragePath(workspaceId: string, extension: string): string {
  const safeWorkspace = workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${safeWorkspace}/avatar.${extension}`;
}

/**
 * Read a response body, aborting as soon as it exceeds `limit`.
 * Returns null when the cap is passed, so an oversized body is never fully
 * materialized.
 */
async function readBounded(
  response: Response,
  limit: number,
): Promise<Uint8Array | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Copy a provider avatar into our bucket and return a durable public URL.
 * Returns null whenever the mirror cannot be completed — the caller keeps
 * whatever URL it already had.
 */
export async function mirrorAvatarToStorage(
  sourceUrl: string | null | undefined,
  workspaceId: string,
): Promise<string | null> {
  if (!workspaceId || !isMirrorableAvatarUrl(sourceUrl)) return null;

  try {
    const response = await fetch(sourceUrl as string, {
      // The signed CDN URL carries its own auth; sending credentials or
      // following a redirect off-allowlist would defeat the host check above.
      redirect: "error",
      signal: AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const contentType = (response.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const extension = ALLOWED_AVATAR_TYPES[contentType];
    // An avatar that is not an image is either an error page or something
    // hostile; either way it does not belong in a public bucket.
    if (!extension) return null;

    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > AVATAR_MAX_BYTES) return null;

    // Read with a running bound rather than buffering first. arrayBuffer()
    // pulls the WHOLE body into memory before any size check, so a response
    // with a missing or malformed Content-Length defeated the cap above — the
    // stated memory bound was not actually enforced against a hostile body.
    const bytes = await readBounded(response, AVATAR_MAX_BYTES);
    if (!bytes || bytes.byteLength === 0) return null;

    const storagePath = avatarStoragePath(workspaceId, extension);
    const storage = supabaseAdmin().storage.from(AVATAR_BUCKET);
    const upload = await storage.upload(storagePath, bytes, {
      contentType,
      upsert: true,
    });
    if (upload.error) return null;

    const publicUrl = storage.getPublicUrl(storagePath).data?.publicUrl;
    if (!publicUrl) return null;
    // Cache-bust so a replaced photo is not masked by the CDN copy of the old
    // one — the path is stable by design, so the query string does this job.
    return `${publicUrl}?v=${Date.now()}`;
  } catch {
    // Timeout, DNS failure, refused redirect, storage outage — all the same
    // answer: no mirror this time, keep the provider URL.
    return null;
  }
}
