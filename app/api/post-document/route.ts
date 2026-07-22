import { NextResponse } from "next/server";
import { scopedSupabase, trackedAccountIds } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// GET /api/post-document?id=<postId>
//
// Resolves the FULL page-image set for a PDF document carousel on demand.
// harvestapi only stores ~3 cover pages in media_urls; LinkedIn's manifest
// (stored as document_manifest_url at scrape time) lists every page two
// hops in:
//   master manifest → perResolutions[].imageManifestUrl → { pages: [...] }
//
// These licdn URLs are short-lived (signed, ~7-day expiry). When the
// manifest has expired we return ok:false and the UI keeps showing the
// stored cover pages. Authorized: the caller's workspace must track the
// post's account (same rule as the feed).
// -----------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 6000;

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; LinkedInSwipeFile/1.0)" },
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) {
      return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
    }
    const sb = await scopedSupabase();

    // Authorize: the post must belong to an account this workspace tracks.
    const trackedIds = await trackedAccountIds(sb.workspaceId);
    if (trackedIds.length === 0) {
      return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    }
    const { data: post } = await sb.raw
      .from("posts")
      .select("id, account_id, document_manifest_url, media_urls")
      .eq("id", id)
      .in("account_id", trackedIds)
      .maybeSingle();
    if (!post) {
      return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    }

    const manifestUrl = post.document_manifest_url as string | null;
    if (!manifestUrl) {
      // No manifest stored (older row, or not a document) — caller falls
      // back to its cover pages.
      return NextResponse.json({ ok: false, error: "no manifest" }, { status: 200 });
    }

    // Hop 1: master manifest → choose a resolution's image manifest.
    const master = (await fetchJson(manifestUrl)) as
      | { perResolutions?: Array<{ width?: number; imageManifestUrl?: string }> }
      | null;
    const resolutions = master?.perResolutions ?? [];
    if (resolutions.length === 0) {
      // Expired or unexpected shape → graceful fallback.
      return NextResponse.json({ ok: false, error: "manifest unavailable" }, { status: 200 });
    }
    // Prefer ~800px wide (good on cards + lightbox); else the largest.
    const chosen =
      resolutions
        .filter((r) => typeof r.imageManifestUrl === "string")
        .sort(
          (a, b) =>
            Math.abs((a.width ?? 0) - 800) - Math.abs((b.width ?? 0) - 800),
        )[0] ?? null;
    if (!chosen?.imageManifestUrl) {
      return NextResponse.json({ ok: false, error: "no image manifest" }, { status: 200 });
    }

    // Hop 2: image manifest → { pages: [...] }.
    const imgManifest = (await fetchJson(chosen.imageManifestUrl)) as
      | { pages?: unknown }
      | null;
    const pages = Array.isArray(imgManifest?.pages)
      ? (imgManifest!.pages as unknown[]).filter(
          (u): u is string => typeof u === "string" && u.startsWith("http"),
        )
      : [];
    if (pages.length === 0) {
      return NextResponse.json({ ok: false, error: "no pages" }, { status: 200 });
    }

    return NextResponse.json({ ok: true, pages });
  } catch (e) {
    return errorResponse(e);
  }
}
