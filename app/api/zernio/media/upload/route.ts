import { NextResponse } from "next/server";
import { validatePostMediaFile } from "@/lib/post-media";
import { getMediaPresignedUrl, mapZernioError } from "@/lib/zernio";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";

// Direct browser-to-Zernio upload is the normal path, especially for large media.
// This route is a small-file fallback for browsers/networks that cannot complete
// the cross-origin presigned PUT. Keep it bounded so app servers never proxy
// huge videos.
const SERVER_UPLOAD_FALLBACK_MAX_BYTES = 25 * 1024 * 1024;

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: "Attach a media file." }, { status: 400 });
    }
    if (file.size > SERVER_UPLOAD_FALLBACK_MAX_BYTES) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "This file is too large for fallback upload. Try again, or use a smaller file.",
        },
        { status: 413 },
      );
    }

    const validation = validatePostMediaFile({
      name: file.name,
      contentType: file.type,
      size: file.size,
    });
    if (!validation.ok) {
      return NextResponse.json({ ok: false, error: validation.error }, { status: 400 });
    }

    const presign = await getMediaPresignedUrl({
      filename: file.name,
      contentType: validation.normalizedContentType,
    });
    const upload = await fetch(presign.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": validation.normalizedContentType },
      body: new Blob([await file.arrayBuffer()], {
        type: validation.normalizedContentType,
      }),
    });
    if (!upload.ok) {
      const text = await upload.text().catch(() => "");
      const err = mapZernioError(upload.status, text);
      return NextResponse.json({ ok: false, error: err.message }, { status: 502 });
    }

    return NextResponse.json({
      ok: true,
      type: validation.type,
      contentType: validation.normalizedContentType,
      ...presign,
    });
  } catch (e) {
    return errorResponse(e);
  }
}

