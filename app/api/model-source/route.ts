import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase, trackedAccountIds } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { fetchEmbedCard } from "@/lib/linkedin-embed-scrape";
import { probeEmbedUrn } from "@/lib/linkedin-url";
import { neutralizeMarkers } from "@/lib/agent/untrusted";
import { getBuiltinTemplate } from "@/lib/templates-builtin";
import {
  resolveActiveLibrary,
  SharedBookmarkAccessError,
} from "@/lib/shared-bookmarks";

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
// Body: { source: 'swipe' | 'bookmark' | 'draft', postId }
//
//  - swipe:    read posts.text (always complete), scoped to the workspace's
//              tracked accounts.
//  - bookmark: read saved_posts.text; if null (scrape failed at save time),
//              fetch the full text from the public embed now (reusing the
//              backfill scraper). Fall back to text_snippet + partial=true if
//              that also fails.
//  - draft:    read chat_artifacts.body (the user's own saved post), with the
//              user's voice-profile identity as the chip author. Used by the
//              Posts page "Model in Chat" so it shows the SAME source chip + clean
//              composer as the swipe-file flow.
//  - template: read a content template's body — either an app built-in (id
//              "builtin:<slug>", resolved from lib/templates-builtin) or a
//              workspace custom row (content_templates.id, a uuid). No author
//              (a template isn't a person's post); the chip shows a generic
//              label + the FileText icon fallback. Used by the Templates page
//              "Model in Chat".
// -----------------------------------------------------------------------------
const bodySchema = z.object({
  source: z.enum(["swipe", "bookmark", "draft", "template"]),
  // posts.id / saved_posts.id / chat_artifacts.id / content_templates.id are
  // uuid columns, but a BUILT-IN template id is "builtin:<slug>" — so accept a
  // broad id string here and validate the exact shape per-source below (a
  // malformed id for a uuid-backed source is caught as a clean 404, and a
  // built-in id that doesn't resolve as a 404 too).
  postId: z.string().min(1).max(100),
  shareId: z.string().uuid().nullable().optional(),
});

const SWIPE_COLS =
  "id, text, account_id, accounts!inner(name, profile_pic_url, archived_at)";

const NO_ROWS_SENTINEL = "00000000-0000-0000-0000-000000000000";

export async function POST(req: Request) {
  try {
    const sb = await scopedSupabase();
    const { source, postId, shareId } = bodySchema.parse(await req.json());

    let postText: string | null = null;
    let authorName: string | null = null;
    let authorAvatar: string | null = null;
    let partial = false;

    // The uuid-backed sources must get a well-formed uuid (the schema no longer
    // enforces it, to allow the "builtin:<slug>" template id). A bad id → clean
    // 404 instead of a raw PostgREST 22P02 cast error.
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(postId);
    if (source !== "template" && !isUuid) {
      return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    }

    if (source === "template") {
      // A generic content template: an app built-in (resolved from code) or a
      // workspace custom row. No author — a template isn't a person's post.
      const builtin = getBuiltinTemplate(postId);
      if (builtin) {
        postText = builtin.body;
      } else {
        if (!isUuid) {
          return NextResponse.json({ ok: false, error: "Template not found" }, { status: 404 });
        }
        const { data, error } = await sb.raw
          .from("content_templates")
          .select("id, body")
          .eq("id", postId)
          .eq("workspace_id", sb.workspaceId)
          .maybeSingle();
        if (error) throw error;
        if (!data) {
          return NextResponse.json({ ok: false, error: "Template not found" }, { status: 404 });
        }
        postText = (data.body as string | null) ?? null;
      }
    } else if (source === "swipe") {
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
    } else if (source === "draft") {
      // The user's own saved post (a chat_artifacts row). The body is always
      // complete, so there's nothing to scrape. The chip identity is the user's
      // voice profile (display name + avatar), matching how the Posts board
      // previews authored the cards.
      const { data, error } = await sb.raw
        .from("chat_artifacts")
        .select("id, body")
        .eq("id", postId)
        .eq("workspace_id", sb.workspaceId)
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        return NextResponse.json({ ok: false, error: "Post not found" }, { status: 404 });
      }
      postText = (data.body as string | null) ?? null;
      const { data: voice } = await sb.raw
        .from("voice_profiles")
        .select("display_name, avatar_url")
        .eq("workspace_id", sb.workspaceId)
        .maybeSingle();
      authorName = (voice?.display_name as string | null) ?? null;
      authorAvatar = (voice?.avatar_url as string | null) ?? null;
    } else {
      // bookmark
      let bookmarkWorkspaceId = sb.workspaceId;
      if (shareId) {
        try {
          const active = await resolveActiveLibrary(shareId);
          bookmarkWorkspaceId = active.workspaceId;
        } catch (error) {
          if (error instanceof SharedBookmarkAccessError) {
            return NextResponse.json({ ok: false, error: "Bookmark not found" }, { status: 404 });
          }
          throw error;
        }
      }
      const { data, error } = await sb.raw
        .from("saved_posts")
        .select(
          "id, text, text_snippet, author_name, profile_pic_url, embed_urn, activity_id",
        )
        .eq("id", postId)
        .eq("workspace_id", bookmarkWorkspaceId)
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        return NextResponse.json({ ok: false, error: "Bookmark not found" }, { status: 404 });
      }
      authorName = (data.author_name as string | null) ?? null;
      authorAvatar = (data.profile_pic_url as string | null) ?? null;
      postText = (data.text as string | null) ?? null;

      // Full text missing — try to fetch it now from the public embed. Light
      // per-workspace throttle on the SCRAPE path (the only outbound-request
      // path here): if this workspace has created many model-sources in the last
      // minute, skip the scrape and fall back to the snippet, so the endpoint
      // can't be used as an outbound-request amplifier against LinkedIn.
      const minuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
      const { count: recentScrapes, error: scrapeLimitError } = await sb.raw
        .from("chat_modeling_sources")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", sb.workspaceId)
        .gte("created_at", minuteAgo);
      // Fail closed on a limiter read error. The saved snippet remains a safe
      // fallback, while treating an unavailable counter as zero would turn a
      // database outage into an unbounded outbound-request path.
      const scrapeAllowed = !scrapeLimitError && (recentScrapes ?? 0) < 20;
      if (!postText && scrapeAllowed) {
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
              .eq("workspace_id", bookmarkWorkspaceId);
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
        // Neutralize any forged envelope markers in the scraped post BEFORE it's
        // stored, so it's safe no matter how the client later weaves it into the
        // "--- POST TO MODEL AFTER ---" envelope.
        post_text: neutralizeMarkers(postText),
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
