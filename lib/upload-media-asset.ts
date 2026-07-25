// One place to POST a file to /api/media-assets and get a typed result.
//
// Exists because two call sites hand-rolled this and both did the same unsafe
// thing: `await res.json()` with no `res.ok` check. When the platform rejects
// an upload BEFORE the route runs — a 413 from the serverless body limit, a
// 502 from a proxy, an HTML error page — the body is not JSON, so the parse
// throws and the user sees:
//
//     Unexpected token 'R', "Request En"... is not valid JSON
//
// which is the string "Request Entity Too Large" being parsed as JSON. The
// real error is right there in the response and we were destroying it.

import { validatePostMediaFile, type PostMediaAttachment } from "@/lib/post-media";

// Vercel caps a serverless function's request body at 4.5 MB, and the limit is
// enforced at the edge — the route never runs, so no amount of server-side
// validation can produce a friendly message. Checking client-side lets us say
// something useful instead of round-tripping into an opaque 413.
export const UPLOAD_BODY_LIMIT_BYTES = 4.5 * 1024 * 1024;

export type UploadResult =
  | { ok: true; attachment: PostMediaAttachment }
  | { ok: false; error: string };

type AssetResponse = {
  ok?: boolean;
  error?: string;
  asset?: {
    id: string;
    filename: string;
    mimeType: string;
    size: number;
    type: "image" | "video" | "document";
    signedUrl?: string | null;
    storageBucket?: string | null;
    storagePath?: string | null;
    createdAt: string;
  };
};

function humanSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Read an error out of a response that may not be JSON at all.
 * Falls back to the status text, and finally to a generic message — never
 * throws, which is the whole point.
 */
export async function readUploadError(res: Response): Promise<string> {
  if (res.status === 413) {
    return `That file is too large to upload (limit ${humanSize(UPLOAD_BODY_LIMIT_BYTES)}). Try a smaller or compressed version.`;
  }
  const text = await res.text().catch(() => "");
  // A JSON error body is the happy path; anything else (HTML, plain text) is
  // surfaced as-is but trimmed so a whole error page can't land in a toast.
  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (parsed?.error) return parsed.error;
  } catch {
    /* not JSON — fall through */
  }
  const snippet = text.trim().slice(0, 140);
  if (snippet && !snippet.startsWith("<")) return snippet;
  return `Upload failed (${res.status}${res.statusText ? ` ${res.statusText}` : ""}).`;
}

/** Upload one file and shape it into a PostMediaAttachment. Never throws. */
export async function uploadMediaAsset(file: File): Promise<UploadResult> {
  const check = validatePostMediaFile({
    name: file.name,
    contentType: file.type,
    size: file.size,
  });
  if (!check.ok) return { ok: false, error: check.error };

  // Pre-flight the platform limit so the user gets a real message rather than
  // an edge-level 413 with a non-JSON body.
  if (file.size > UPLOAD_BODY_LIMIT_BYTES) {
    return {
      ok: false,
      error: `${file.name} is ${humanSize(file.size)} — the upload limit is ${humanSize(UPLOAD_BODY_LIMIT_BYTES)}. Try a smaller or compressed version.`,
    };
  }

  const form = new FormData();
  form.append("file", file, file.name);

  let res: Response;
  try {
    res = await fetch("/api/media-assets", { method: "POST", body: form });
  } catch {
    return { ok: false, error: "Upload failed — check your connection and try again." };
  }

  // THE FIX: never parse the body until we know the request succeeded.
  if (!res.ok) return { ok: false, error: await readUploadError(res) };

  let data: AssetResponse;
  try {
    data = (await res.json()) as AssetResponse;
  } catch {
    return { ok: false, error: "The server returned an unreadable response. Try again." };
  }
  if (!data.ok || !data.asset) {
    return { ok: false, error: data.error || "Couldn't upload that file." };
  }

  const asset = data.asset;
  return {
    ok: true,
    attachment: {
      id: `asset:${asset.id}`,
      source: "library",
      assetId: asset.id,
      name: asset.filename,
      mimeType: asset.mimeType,
      size: asset.size,
      type: asset.type,
      storageBucket: asset.storageBucket,
      storagePath: asset.storagePath,
      previewUrl: asset.signedUrl,
      uploadedAt: asset.createdAt,
    },
  };
}
