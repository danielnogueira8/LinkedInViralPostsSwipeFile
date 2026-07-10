import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  POST_MEDIA_MAX_BYTES,
  validatePostMediaFile,
  type PostMediaAttachment,
  type PostMediaType,
} from "@/lib/post-media";
import { getMediaPresignedUrl, uploadToPresignedUrl } from "@/lib/zernio";

export const MEDIA_LIBRARY_BUCKET = "media-assets";
export const MEDIA_LIBRARY_QUOTA_BYTES = 1 * 1024 * 1024 * 1024;
export const MEDIA_LIBRARY_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MEDIA_LIBRARY_SIGNED_URL_SECONDS = 60 * 60;

export type MediaAsset = {
  id: string;
  workspace_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  media_type: PostMediaType;
  storage_bucket: string;
  storage_path: string;
  created_at: string;
};

export type MediaAssetDto = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  type: PostMediaType;
  signedUrl: string | null;
  createdAt: string;
};

export function validateLibraryMediaFile(input: {
  name: string;
  contentType: string;
  size: number;
}): { ok: true; type: PostMediaType; normalizedContentType: string } | { ok: false; error: string } {
  const validation = validatePostMediaFile(input);
  if (!validation.ok) return validation;
  if (validation.normalizedContentType === "video/x-msvideo") {
    return { ok: false, error: "Unsupported media type. Use JPG, PNG, GIF, WebP, MP4, MOV, WebM, or PDF." };
  }
  if (input.size > MEDIA_LIBRARY_MAX_FILE_BYTES) {
    return { ok: false, error: "Media library uploads can be up to 50 MB." };
  }
  if (input.size > POST_MEDIA_MAX_BYTES[validation.type]) {
    return { ok: false, error: "This file is too large for LinkedIn publishing." };
  }
  return validation;
}

export function mediaAssetToAttachment(asset: {
  id: string;
  filename: string;
  mime_type?: string;
  mimeType?: string;
  size_bytes?: number;
  size?: number;
  media_type?: PostMediaType;
  type?: PostMediaType;
  storage_bucket?: string;
  storage_path?: string;
  created_at?: string;
  createdAt?: string;
  signedUrl?: string | null;
}): PostMediaAttachment {
  const uploadedAt = asset.created_at ?? asset.createdAt ?? new Date().toISOString();
  return {
    id: `asset:${asset.id}`,
    source: "library",
    assetId: asset.id,
    name: asset.filename,
    mimeType: asset.mime_type ?? asset.mimeType ?? "application/octet-stream",
    size: asset.size_bytes ?? asset.size ?? 0,
    type: asset.media_type ?? asset.type ?? "image",
    storageBucket: asset.storage_bucket ?? MEDIA_LIBRARY_BUCKET,
    storagePath: asset.storage_path,
    previewUrl: asset.signedUrl ?? null,
    uploadedAt: Number.isFinite(Date.parse(uploadedAt))
      ? new Date(uploadedAt).toISOString()
      : new Date().toISOString(),
  };
}

export function storagePathForMedia(workspaceId: string, filename: string): string {
  const safeName = filename.replace(/[^\w.\-]+/g, "-").replace(/-+/g, "-").slice(0, 120) || "media";
  return `${workspaceId}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}-${safeName}`;
}

export async function signedUrlForAsset(
  sb: SupabaseClient,
  asset: Pick<MediaAsset, "storage_bucket" | "storage_path">,
): Promise<string | null> {
  const { data } = await sb.storage
    .from(asset.storage_bucket || MEDIA_LIBRARY_BUCKET)
    .createSignedUrl(asset.storage_path, MEDIA_LIBRARY_SIGNED_URL_SECONDS);
  return data?.signedUrl ?? null;
}

export async function workspaceMediaUsage(
  sb: SupabaseClient,
  workspaceId: string,
): Promise<number> {
  const { data, error } = await sb
    .from("media_assets")
    .select("size_bytes")
    .eq("workspace_id", workspaceId)
    .is("deleted_at", null);
  if (error) throw error;
  return (data ?? []).reduce((sum, row) => sum + Number(row.size_bytes ?? 0), 0);
}

export async function claimMediaQuota(
  sb: SupabaseClient,
  workspaceId: string,
  sizeBytes: number,
): Promise<{ claimId: string; usedBefore: number } | null> {
  const { data, error } = await sb.rpc("claim_media_quota", {
    p_workspace_id: workspaceId,
    p_size_bytes: sizeBytes,
    p_limit_bytes: MEDIA_LIBRARY_QUOTA_BYTES,
  });
  if (error) throw error;
  const claim = Array.isArray(data) ? data[0] : null;
  if (!claim?.claim_id) return null;
  return {
    claimId: String(claim.claim_id),
    usedBefore: Number(claim.used_before ?? 0),
  };
}

export async function settleMediaQuotaClaim(
  sb: SupabaseClient,
  claimId: string,
  status: "completed" | "released",
): Promise<void> {
  const { error } = await sb
    .from("media_quota_claims")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", claimId)
    .eq("status", "reserved");
  if (error) throw error;
}

export async function ensureZernioMediaAttachments(opts: {
  sb: SupabaseClient;
  workspaceId: string;
  attachments: PostMediaAttachment[];
}): Promise<PostMediaAttachment[]> {
  const out: PostMediaAttachment[] = [];
  for (const attachment of opts.attachments) {
    if ((attachment.source ?? "zernio") === "zernio") {
      out.push(attachment);
      continue;
    }
    if (!attachment.assetId) throw new Error("One library media attachment is missing its asset id.");
    const { data: asset, error } = await opts.sb
      .from("media_assets")
      .select("id, filename, mime_type, size_bytes, media_type, storage_bucket, storage_path, created_at")
      .eq("id", attachment.assetId)
      .eq("workspace_id", opts.workspaceId)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) throw error;
    if (!asset) throw new Error("One library media attachment could not be found.");

    const row = asset as MediaAsset;
    const download = await opts.sb.storage
      .from(row.storage_bucket || MEDIA_LIBRARY_BUCKET)
      .download(row.storage_path);
    if (download.error || !download.data) {
      throw new Error("Could not load one library media file for publishing.");
    }

    const presign = await getMediaPresignedUrl({
      filename: row.filename,
      contentType: row.mime_type,
    });
    await uploadToPresignedUrl({
      uploadUrl: presign.uploadUrl,
      contentType: row.mime_type,
      body: download.data,
    });
    out.push({
      id: `zernio:${row.id}:${Date.now()}`,
      source: "zernio",
      assetId: row.id,
      name: row.filename,
      mimeType: row.mime_type,
      size: Number(row.size_bytes),
      type: row.media_type,
      url: presign.publicUrl,
      key: presign.key,
      uploadedAt: new Date().toISOString(),
    });
  }
  return out;
}
