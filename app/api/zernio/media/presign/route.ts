import { NextResponse } from "next/server";
import { z } from "zod";
import { validatePostMediaFile } from "@/lib/post-media";
import { getMediaPresignedUrl } from "@/lib/zernio";
import { errorResponse } from "@/lib/workspace";
import { scopedSupabase } from "@/lib/supabase-scoped";
import {
  claimMediaQuota,
  settleMediaQuotaClaim,
  ZERNIO_MEDIA_WINDOW_BYTES,
} from "@/lib/media-library";

export const runtime = "nodejs";

const requestSchema = z.object({
  filename: z.string().trim().min(1).max(240),
  contentType: z.string().trim().min(3).max(120),
  size: z.number().int().positive(),
});

export async function POST(req: Request) {
  try {
    const sb = await scopedSupabase();
    const input = requestSchema.parse(await req.json());
    const validation = validatePostMediaFile({
      name: input.filename,
      contentType: input.contentType,
      size: input.size,
    });
    if (!validation.ok) {
      return NextResponse.json({ ok: false, error: validation.error }, { status: 400 });
    }

    const reservation = await claimMediaQuota(
      sb.raw,
      sb.workspaceId,
      input.size,
      ZERNIO_MEDIA_WINDOW_BYTES,
    );
    if (!reservation) {
      return NextResponse.json(
        { ok: false, error: "Too much media was uploaded recently. Try again in a few minutes." },
        { status: 429 },
      );
    }

    try {
      const presign = await getMediaPresignedUrl({
        filename: input.filename,
        contentType: validation.normalizedContentType,
      });

      return NextResponse.json({
        ok: true,
        type: validation.type,
        contentType: validation.normalizedContentType,
        ...presign,
      });
    } catch (error) {
      await settleMediaQuotaClaim(
        sb.workspaceId,
        reservation.claimId,
        "released",
      ).catch((releaseError) => {
        console.error("Failed to release Zernio media quota claim", releaseError);
      });
      throw error;
    }
  } catch (e) {
    return errorResponse(e);
  }
}
