import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import {
  MEDIA_LIBRARY_BUCKET,
  MEDIA_LIBRARY_QUOTA_BYTES,
  mediaAssetToAttachment,
  storagePathForMedia,
  validateLibraryMediaFile,
  workspaceMediaUsage,
  type MediaAsset,
} from "@/lib/media-library";

export const runtime = "nodejs";

const ASSET_SELECT =
  "id, workspace_id, filename, mime_type, size_bytes, media_type, storage_bucket, storage_path, created_at";

function previewUrl(asset: MediaAsset): string | null {
  return asset.media_type === "image" ? `/api/media-assets/${asset.id}/preview` : null;
}

export async function GET() {
  try {
    const sb = await scopedSupabase();
    const [{ data, error }, usedBytes] = await Promise.all([
      sb.raw
        .from("media_assets")
        .select(ASSET_SELECT)
        .eq("workspace_id", sb.workspaceId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(200),
      workspaceMediaUsage(sb.raw, sb.workspaceId),
    ]);
    if (error) throw error;

    const assets = ((data ?? []) as MediaAsset[]).map((asset) => ({
        ...mediaAssetToAttachment(asset),
        id: asset.id,
        filename: asset.filename,
        mimeType: asset.mime_type,
        size: Number(asset.size_bytes),
        type: asset.media_type,
        signedUrl: previewUrl(asset),
        createdAt: asset.created_at,
      }));

    return NextResponse.json({
      ok: true,
      assets,
      quota: {
        usedBytes,
        limitBytes: MEDIA_LIBRARY_QUOTA_BYTES,
        remainingBytes: Math.max(0, MEDIA_LIBRARY_QUOTA_BYTES - usedBytes),
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const sb = await scopedSupabase();
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: "Attach a media file." }, { status: 400 });
    }

    const validation = validateLibraryMediaFile({
      name: file.name,
      contentType: file.type,
      size: file.size,
    });
    if (!validation.ok) {
      return NextResponse.json({ ok: false, error: validation.error }, { status: 400 });
    }

    const usedBytes = await workspaceMediaUsage(sb.raw, sb.workspaceId);
    if (usedBytes + file.size > MEDIA_LIBRARY_QUOTA_BYTES) {
      return NextResponse.json(
        { ok: false, error: "This workspace media library is full. Delete older media before uploading more." },
        { status: 413 },
      );
    }

    const storagePath = storagePathForMedia(sb.workspaceId, file.name);
    const upload = await sb.raw.storage
      .from(MEDIA_LIBRARY_BUCKET)
      .upload(storagePath, file, {
        contentType: validation.normalizedContentType,
        upsert: false,
      });
    if (upload.error) throw upload.error;

    const { data, error } = await sb.raw
      .from("media_assets")
      .insert({
        workspace_id: sb.workspaceId,
        filename: file.name,
        mime_type: validation.normalizedContentType,
        size_bytes: file.size,
        media_type: validation.type,
        storage_bucket: MEDIA_LIBRARY_BUCKET,
        storage_path: storagePath,
      })
      .select(ASSET_SELECT)
      .single();
    if (error) throw error;

    const asset = data as MediaAsset;
    return NextResponse.json({
      ok: true,
      asset: {
        ...mediaAssetToAttachment(asset),
        id: asset.id,
        filename: asset.filename,
        mimeType: asset.mime_type,
        size: Number(asset.size_bytes),
        type: asset.media_type,
        signedUrl: previewUrl(asset),
        createdAt: asset.created_at,
      },
      quota: {
        usedBytes: usedBytes + file.size,
        limitBytes: MEDIA_LIBRARY_QUOTA_BYTES,
        remainingBytes: Math.max(0, MEDIA_LIBRARY_QUOTA_BYTES - usedBytes - file.size),
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
