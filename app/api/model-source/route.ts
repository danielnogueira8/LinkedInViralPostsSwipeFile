import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase, trackedAccountIds } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { fetchEmbedCard } from "@/lib/linkedin-embed-scrape";
import { probeEmbedUrn } from "@/lib/linkedin-url";

export const runtime = "nodejs";
// The bookmark path may scrape the public embed for full text, which is a
// network round-trip; give it room without risking a gateway timeout.
export const maxDuration = 60;

// -----------------------------------------------------------------------------
// POST /api/model-source
//
// Stash a post to model after, keyed by id, and return that id. The chat opens
// with ?model=<id>, fetches the stash, and uses the full text as the modeling
// source. The text is resolved SERVER-SIDE from the post's id (never trusted
// from the client) so a caller can't inject arbitrary content.
//
// Body: { source: 'swipe' | 'bookmark', postId }
//
//  - swipe:    read posts.text (always complete), scoped to the workspace's
//              tracked accounts.
//  - bookmark: read saved_posts.text; if null (scrape failed at save time),
//              fetch the full text from the public embed now (reusing the
//              backfill scraper). Fall back to text_snippet + partial=true if
//              that also fails.
// -----------------------------------------------------------------------------
const bodySchema = z.object({
  source: z.enum(["swipe", "bookmark"]),
  postId: z.string().min(1),
});

const SWIPE_COLS =
  "id, text, account_id, accounts!inner(name, profile_pic_url, archived_at)";

const NO_ROWS_SENTINEL = "00000000-0000-0000-0000-000000000000";

export async function POST(req: Request) {
  try {
    const sb = await scopedSupabase();
    const { source, postId } = bodySchema.parse(await req.json());

    let postText: string | null = null;
    let authorName: string | null = null;
    let authorAvatar: string | null = null;
    let partial = false;

    if (source === "swipe") {
      const accountIds = await trackedAccountIds(sb.workspaceId);
      const { data, error } = await sb.raw
        .from("posts")
        .select(SWIPE_COLS)
        .eq("id", postId)
        .in("account_id", accountIds.length ? accountIds : [NO_ROWS_SENTINEL])
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        return NextResponse.json({ ok: false, error: "Post not found" }, { status: 404 });
      }
      const acc = Array.isArray(data.accounts) ? data.accounts[0] : data.accounts;
      postText = (data.text as string | null) ?? null;
      authorName = (acc?.name as string | null) ?? null;
      authorAvatar = (acc?.profile_pic_url as string | null) ?? null;
    } else {
      // bookmark
      const { data, error } = await sb.raw
        .from("saved_posts")
        .select(
          "id, text, text_snippet, author_name, profile_pic_url, embed_urn, activity_id",
        )
        .eq("id", postId)
        .eq("workspace_id", sb.workspaceId)
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        return NextResponse.json({ ok: false, error: "Bookmark not found" }, { status: 404 });
      }
      authorName = (data.author_name as string | null) ?? null;
      authorAvatar = (data.profile_pic_url as string | null) ?? null;
      postText = (data.text as string | null) ?? null;

      // Full text missing — try to fetch it now from the public embed.
      if (!postText) {
        const urn =
          (data.embed_urn as string | null) ??
          (await probeEmbedUrn(data.activity_id as string).catch(() => null)) ??
          null;
        if (urn) {
          const card = await fetchEmbedCard(urn).catch(() => null);
          if (card?.text) {
            postText = card.text;
            // Backfill the row so we don't re-scrape next time.
            await sb.raw
              .from("saved_posts")
              .update({ embed_urn: urn, text: card.text })
              .eq("id", postId)
              .eq("workspace_id", sb.workspaceId);
          }
        }
      }

      // Still nothing — fall back to the snippet and flag it as partial.
      if (!postText) {
        postText = (data.text_snippet as string | null) ?? null;
        partial = true;
      }
    }

    if (!postText || !postText.trim()) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Couldn't get this post's text to model from. It may be private or deleted.",
        },
        { status: 422 },
      );
    }

    const { data: row, error: insErr } = await sb.raw
      .from("chat_modeling_sources")
      .insert({
        workspace_id: sb.workspaceId,
        post_text: postText,
        author_name: authorName,
        author_avatar: authorAvatar,
        source,
        source_post_id: postId,
        partial,
      })
      .select("id")
      .single();
    if (insErr) throw insErr;

    return NextResponse.json({ ok: true, id: row.id, partial });
  } catch (e) {
    return errorResponse(e);
  }
}
