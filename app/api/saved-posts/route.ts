import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import {
  authorHandleFromProfileUrl,
  authorHandleFromUrl,
  canonicalPostUrl,
  displayNameFromHandle,
  extractUrnFromUrl,
  fetchHandleViaRedirect,
  fetchOEmbed,
  probeEmbedUrn,
} from "@/lib/linkedin-url";

export const runtime = "nodejs";
// oEmbed fetch can take a few seconds; default Vercel 10s is fine but bump
// to 20 for headroom on cold lambdas + slow LinkedIn responses.
export const maxDuration = 20;

type SaveBody = {
  url?: string;
  note?: string;
  category?: string;
};

// -----------------------------------------------------------------------------
// POST /api/saved-posts  — save (or no-op upsert) a LinkedIn post by URL
// -----------------------------------------------------------------------------
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as SaveBody;
    const rawUrl = (body.url ?? "").trim();
    const note = (body.note ?? "").trim() || null;
    // Empty string in `category` means "no niche" — coerce to null so it
    // matches the column default and our `is null` queries elsewhere.
    const categoryId = (body.category ?? "").trim() || null;

    if (!rawUrl) {
      return NextResponse.json({ ok: false, error: "URL is required" }, { status: 400 });
    }

    const urn = extractUrnFromUrl(rawUrl);
    if (!urn) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Couldn't read that URL. Paste a LinkedIn post link — either /feed/update/urn:li:activity:... or /posts/...",
        },
        { status: 400 },
      );
    }
    const activityId = urn.id;

    const { userId } = await auth();
    const sb = await scopedSupabase();
    const canonical = canonicalPostUrl(activityId);
    const handleFromUrl = authorHandleFromUrl(rawUrl);

    // Idempotent: if this workspace already saved this post, return the
    // existing row so the UI can just refresh and feel snappy.
    const { data: existing } = await sb.raw
      .from("saved_posts")
      .select("id, post_url, activity_id, embed_urn, author_name, author_handle, text_snippet, note, category_id, saved_at")
      .eq("workspace_id", sb.workspaceId)
      .eq("activity_id", activityId)
      .maybeSingle();

    if (existing) {
      // Opportunistic backfill: rows saved before migration 017, or rows
      // whose embed_urn was set incorrectly by migration 018's URL-shape
      // heuristic, would otherwise 404 in the iframe forever. Re-paste is
      // the user's natural retry; honor it by re-probing when the stored
      // value is null. A failed probe leaves the row as-is — we don't
      // want a transient network error to wipe a working URN.
      if (existing.embed_urn === null) {
        const refreshed = await probeEmbedUrn(activityId);
        if (refreshed) {
          const { data: updated } = await sb.raw
            .from("saved_posts")
            .update({ embed_urn: refreshed })
            .eq("id", existing.id)
            .select(
              "id, post_url, activity_id, embed_urn, author_name, author_handle, text_snippet, note, category_id, saved_at",
            )
            .single();
          if (updated) {
            return NextResponse.json({ ok: true, saved: updated, alreadySaved: true });
          }
        }
      }
      return NextResponse.json({ ok: true, saved: existing, alreadySaved: true });
    }

    // Free enrichment: oEmbed gives us author name + a ~200 char snippet.
    // If LinkedIn rate-limits or returns garbage, we still save the row with
    // handle-derived display name; the user can always click through.
    // In parallel, probe the embed endpoint to find which URN type (share
    // vs. activity) the post actually resolves under — this is the only
    // reliable source. We previously guessed from URL shape; that's wrong.
    const [oembed, probedUrn] = await Promise.all([
      fetchOEmbed(canonical),
      probeEmbedUrn(activityId),
    ]);
    // Handle resolution chain — first hit wins:
    //   1. Pasted URL was a /posts/handle_... slug → handle came for free.
    //   2. oEmbed succeeded and gave us author_url (linkedin.com/in/<handle>)
    //      — works for posts pasted as the canonical activity URN form.
    //   3. Follow redirects on the canonical URL; LinkedIn usually rewrites
    //      public activity URNs to the pretty-slug form, which carries the
    //      handle. Costs one extra HTTP call, only used when oEmbed gave
    //      us nothing.
    let handle = handleFromUrl;
    if (!handle && oembed.authorProfileUrl) {
      handle = authorHandleFromProfileUrl(oembed.authorProfileUrl);
    }
    if (!handle) {
      handle = await fetchHandleViaRedirect(canonical);
    }
    const authorName =
      oembed.authorName ?? (handle ? displayNameFromHandle(handle) : null);

    const { data: inserted, error } = await sb.raw
      .from("saved_posts")
      .insert({
        workspace_id: sb.workspaceId,
        activity_id: activityId,
        post_url: canonical,
        original_url: rawUrl,
        author_name: authorName,
        author_handle: handle,
        text_snippet: oembed.textSnippet,
        // Priority: oEmbed (when present, authoritative since LinkedIn
        // itself generated the iframe) > probed URN (verified to return 200
        // from the embed endpoint). If both fail (LinkedIn rate-limited,
        // network blip, or genuinely deleted post), store null rather than
        // a URL-shape guess that's likely to 404. The "re-paste to retry"
        // path in the duplicate-save branch above will re-probe and update
        // the row when the user notices and tries again.
        embed_urn: oembed.embedUrn ?? probedUrn ?? null,
        note,
        category_id: categoryId,
        saved_by: userId ?? null,
      })
      .select("id, post_url, activity_id, embed_urn, author_name, author_handle, text_snippet, note, category_id, saved_at")
      .single();

    if (error || !inserted) {
      // Treat unique-violation as "already saved" (race condition between two
      // concurrent saves of the same URL). Other errors propagate.
      if (error?.code === "23505") {
        const { data: row } = await sb.raw
          .from("saved_posts")
          .select(
            "id, post_url, activity_id, embed_urn, author_name, author_handle, text_snippet, note, category_id, saved_at",
          )
          .eq("workspace_id", sb.workspaceId)
          .eq("activity_id", activityId)
          .maybeSingle();
        if (row) return NextResponse.json({ ok: true, saved: row, alreadySaved: true });
      }
      throw error || new Error("insert failed");
    }

    return NextResponse.json({ ok: true, saved: inserted, alreadySaved: false });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

// -----------------------------------------------------------------------------
// DELETE /api/saved-posts?id=<uuid>  — remove a saved post
// -----------------------------------------------------------------------------
export async function DELETE(req: Request) {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) {
      return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
    }
    const sb = await scopedSupabase();
    const { error } = await sb.raw
      .from("saved_posts")
      .delete()
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
