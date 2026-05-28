import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireWorkspaceId } from "@/lib/workspace";
import { isAdmin } from "@/lib/admin";
import { fetchEmbedCard } from "@/lib/linkedin-embed-scrape";
import { probeEmbedUrn } from "@/lib/linkedin-url";

export const runtime = "nodejs";
export const maxDuration = 300;

// Admin-only one-time backfill: populate the native-render columns
// (migration 026) for saved_posts that predate it. We scrape the public
// embed page (free, no Apify) for each row missing `text`, using its stored
// embed_urn — or re-probing when that's null too.
//
// Processes a bounded batch per invocation (default 40) so a large backlog
// doesn't blow maxDuration; the response reports `remaining` so the caller
// can hit the endpoint again until it reaches 0. Each row is independent;
// failures are skipped and counted, never fatal.
//
// Service-role client: bypasses RLS so it sees every workspace's bookmarks.
function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function POST(req: Request) {
  await requireWorkspaceId();
  if (!(await isAdmin())) {
    return NextResponse.json({ ok: false, error: "Admin only." }, { status: 403 });
  }

  const batch = Math.min(
    100,
    Math.max(1, parseInt(new URL(req.url).searchParams.get("batch") ?? "40", 10) || 40),
  );

  // mode=remedia re-scrapes rows that already have text but media_type
  // 'none' — needed to repair rows backfilled before the image-variant fix
  // (feedshare-* URLs were missed, so every image post stored 'none').
  const mode = new URL(req.url).searchParams.get("mode");

  try {
    const sb = serviceClient();

    const base = sb.from("saved_posts").select("id, activity_id, embed_urn");
    const query =
      mode === "remedia"
        ? base.not("text", "is", null).eq("media_type", "none")
        : base.is("text", null);
    const { data: rows, error } = await query
      .order("saved_at", { ascending: false })
      .limit(batch);
    if (error) throw error;

    let updated = 0;
    let failed = 0;
    for (const row of rows ?? []) {
      const urn =
        (row.embed_urn as string | null) ??
        (await probeEmbedUrn(row.activity_id as string)) ??
        null;
      if (!urn) {
        failed++;
        continue;
      }
      const card = await fetchEmbedCard(urn);
      if (!card.text) {
        failed++;
        continue;
      }
      const patch: Record<string, unknown> = { embed_urn: urn, text: card.text };
      if (card.authorName) patch.author_name = card.authorName;
      if (card.profilePicUrl) patch.profile_pic_url = card.profilePicUrl;
      if (card.mediaType !== "none") {
        patch.media_type = card.mediaType;
        patch.media_urls = card.mediaUrls;
      }
      if (card.reactions !== null) patch.reactions = card.reactions;
      if (card.comments !== null) patch.comments = card.comments;
      const { error: upErr } = await sb
        .from("saved_posts")
        .update(patch)
        .eq("id", row.id);
      if (upErr) failed++;
      else updated++;
    }

    // How many still match the selection after this batch.
    //
    // Note for remedia mode: genuinely image-less posts stay media_type
    // 'none' forever, so `remaining` never hits 0. The caller should stop
    // when a full batch yields updated===0 (no more repairable rows) rather
    // than waiting for remaining===0. `processed < batch` also signals the
    // table has been fully walked.
    const countQuery = sb
      .from("saved_posts")
      .select("id", { count: "exact", head: true });
    const { count: remaining } =
      mode === "remedia"
        ? await countQuery.not("text", "is", null).eq("media_type", "none")
        : await countQuery.is("text", null);

    return NextResponse.json({
      ok: true,
      mode: mode === "remedia" ? "remedia" : "default",
      processed: rows?.length ?? 0,
      updated,
      failed,
      remaining: remaining ?? 0,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
