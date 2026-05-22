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
} from "@/lib/linkedin-url";

export const runtime = "nodejs";
// oEmbed fetch can take a few seconds; default Vercel 10s is fine but bump
// to 20 for headroom on cold lambdas + slow LinkedIn responses.
export const maxDuration = 20;

type SaveBody = {
  url?: string;
  note?: string;
};

// -----------------------------------------------------------------------------
// POST /api/saved-posts  — save (or no-op upsert) a LinkedIn post by URL
// -----------------------------------------------------------------------------
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as SaveBody;
    const rawUrl = (body.url ?? "").trim();
    const note = (body.note ?? "").trim() || null;

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
    // The URL shape tells us deterministically whether the id is an activity
    // URN or a share URN — and the two are NOT interchangeable in the embed
    // endpoint. Build `embed_urn` from this and never depend on oEmbed
    // returning iframe HTML (which it often doesn't, especially when
    // LinkedIn serves a generic HTML response instead of JSON).
    const knownUrn = `urn:li:${urn.type}:${urn.id}`;

    const { userId } = await auth();
    const sb = await scopedSupabase();
    const canonical = canonicalPostUrl(activityId);
    const handleFromUrl = authorHandleFromUrl(rawUrl);

    // Idempotent: if this workspace already saved this post, return the
    // existing row so the UI can just refresh and feel snappy.
    const { data: existing } = await sb.raw
      .from("saved_posts")
      .select("id, post_url, activity_id, embed_urn, author_name, author_handle, text_snippet, note, saved_at")
      .eq("workspace_id", sb.workspaceId)
      .eq("activity_id", activityId)
      .maybeSingle();

    if (existing) {
      return NextResponse.json({ ok: true, saved: existing, alreadySaved: true });
    }

    // Free enrichment: oEmbed gives us author name + a ~200 char snippet.
    // If LinkedIn rate-limits or returns garbage, we still save the row with
    // handle-derived display name; the user can always click through.
    const oembed = await fetchOEmbed(canonical);
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
        // Prefer the URN oEmbed told us about, but fall back to the one we
        // inferred from the URL shape — that fallback is what fixes
        // /posts/... URLs when oEmbed returns HTML instead of JSON.
        embed_urn: oembed.embedUrn ?? knownUrn,
        note,
        saved_by: userId ?? null,
      })
      .select("id, post_url, activity_id, embed_urn, author_name, author_handle, text_snippet, note, saved_at")
      .single();

    if (error || !inserted) {
      // Treat unique-violation as "already saved" (race condition between two
      // concurrent saves of the same URL). Other errors propagate.
      if (error?.code === "23505") {
        const { data: row } = await sb.raw
          .from("saved_posts")
          .select(
            "id, post_url, activity_id, embed_urn, author_name, author_handle, text_snippet, note, saved_at",
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
