import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import {
  fetchSwipePage,
  resolveSwipeAccountIds,
  SWIPE_PAGE_SIZE,
} from "@/lib/swipe-query";

export const runtime = "nodejs";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDayStart(d: string | null): string | null {
  if (!d || !DATE_RE.test(d)) return null;
  const dt = new Date(`${d}T00:00:00.000Z`);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}
function parseDayEnd(d: string | null): string | null {
  if (!d || !DATE_RE.test(d)) return null;
  const dt = new Date(`${d}T23:59:59.999Z`);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}
// Same sanitization the page uses: strip PostgREST .or() structural chars.
function sanitizeCreatorQuery(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[,()%*]/g, "").trim().slice(0, 80);
  return cleaned.length >= 1 ? cleaned : null;
}

// -----------------------------------------------------------------------------
// GET /api/swipe-posts — paginated viral feed for infinite scroll
//
//   ?offset=<n>  pagination cursor (default 0)
//   ?category, ?sort, ?dir, ?rec, ?from, ?to, ?minR, ?minC, ?type, ?q
//     — same filters as the swipe page URL
//
// Returns enriched posts identical to the page's first batch (both go
// through fetchSwipePage), workspace-scoped via resolveSwipeAccountIds.
// -----------------------------------------------------------------------------
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const p = url.searchParams;
    const offset = Math.max(0, parseInt(p.get("offset") ?? "0", 10) || 0);

    const sb = await scopedSupabase();
    const category = p.get("category") || null;
    const creatorQuery = sanitizeCreatorQuery(p.get("q"));
    const accountIds = await resolveSwipeAccountIds(
      sb.workspaceId,
      category,
      creatorQuery,
    );

    const minRRaw = p.get("minR");
    const minCRaw = p.get("minC");
    const page = await fetchSwipePage({
      accountIds,
      filters: {
        category,
        sort: p.get("sort"),
        dir: p.get("dir"),
        rec: p.get("rec"),
        from: parseDayStart(p.get("from")),
        to: parseDayEnd(p.get("to")),
        minR: minRRaw ? Math.max(0, parseInt(minRRaw, 10) || 0) : null,
        minC: minCRaw ? Math.max(0, parseInt(minCRaw, 10) || 0) : null,
        type: p.get("type"),
        q: creatorQuery,
      },
      offset,
      limit: SWIPE_PAGE_SIZE,
    });

    return NextResponse.json({ ok: true, ...page });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
