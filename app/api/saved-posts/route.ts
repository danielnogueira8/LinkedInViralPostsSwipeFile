import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
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
  postedAtFromLinkedInId,
  postUrlForUrn,
  postUrlFromUrn,
  probeEmbedUrn,
} from "@/lib/linkedin-url";
import { fetchEmbedCard } from "@/lib/linkedin-embed-scrape";
import {
  canHardMutate,
  resolveActiveLibrary,
  SharedBookmarkAccessError,
} from "@/lib/shared-bookmarks";
import {
  fetchBookmarksPage,
  BOOKMARKS_PAGE_SIZE,
  normalizeBookmarkSort,
} from "@/lib/bookmarks-query";
import { validateCategoryId, visibleCategoriesOr } from "@/lib/categories";
import { classifyPost, normalizePostType, type PostType } from "@/lib/post-type";

// Invalidate the Next.js Router Cache for /dashboard/bookmarks so a save
// (or delete) done from any other tab — Swipe File especially — surfaces
// in the Bookmarks tab on the very next navigation, no manual refresh
// needed. Called from every ok:true return in POST/DELETE. Cheap: it just
// marks the segment stale; the actual re-fetch happens when the user
// navigates. Wrapped in a helper because next/cache throws when called
// outside a request scope, and swallowing that keeps the API contract
// unchanged in the (rare) case of a background reindex.
function invalidateBookmarksSegment(): void {
  try {
    revalidatePath("/dashboard/bookmarks");
  } catch {
    /* never surface a cache-invalidation glitch to the caller */
  }
}

const SELECT_COLS =
  "id, post_url, activity_id, embed_urn, author_name, author_handle, text_snippet, text, profile_pic_url, media_type, media_urls, video_url, reactions, comments, note, category_id, post_type, posted_at, saved_at, workspace_id, created_by_user_id";

export const runtime = "nodejs";
// oEmbed fetch can take a few seconds; default Vercel 10s is fine but bump
// to 20 for headroom on cold lambdas + slow LinkedIn responses.
export const maxDuration = 20;

// -----------------------------------------------------------------------------
// GET /api/saved-posts  — paginated list for the bookmarks infinite scroll
//
//   ?share=<id>     — read a shared library instead of own (auth-gated)
//   ?category=<id>  — niche filter
//   ?offset=<n>     — pagination cursor (default 0)
//
// Returns enriched cards (override-applied note/category, contributor
// names, category labels) identical to what the bookmarks page renders
// for its first batch — both go through fetchBookmarksPage so there's no
// drift between SSR'd rows and lazily-loaded ones.
// -----------------------------------------------------------------------------
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const shareId = url.searchParams.get("share");
    const categoryId = url.searchParams.get("category");
    const sort = normalizeBookmarkSort(url.searchParams.get("sort"));
    const postType = normalizePostType(url.searchParams.get("type"));
    const offsetRaw = url.searchParams.get("offset");
    const offset = Math.max(0, parseInt(offsetRaw ?? "0", 10) || 0);

    let active;
    try {
      active = await resolveActiveLibrary(shareId);
    } catch (e) {
      if (e instanceof SharedBookmarkAccessError) {
        return NextResponse.json({ ok: false, error: e.message }, { status: 404 });
      }
      throw e;
    }

    // Category labels for chip text. Curated buckets + the ACTIVE library
    // owner's custom categories, so a shared library's bookmarks filed under
    // the owner's custom category still resolve a chip label. Small table,
    // cheap to read.
    const sb = await scopedSupabase();
    const { data: categoryRows } = await sb.raw
      .from("categories")
      .select("id, label")
      .or(visibleCategoriesOr(active.workspaceId));
    const categoryLabels = new Map(
      ((categoryRows ?? []) as Array<{ id: string; label: string }>).map((c) => [
        c.id,
        c.label,
      ]),
    );

    const page = await fetchBookmarksPage({
      activeWorkspaceId: active.workspaceId,
      userId: active.userId,
      isOwnView: active.kind === "own",
      categoryId: categoryId || null,
      categoryLabels,
      offset,
      limit: BOOKMARKS_PAGE_SIZE,
      sort,
      postType,
    });

    return NextResponse.json({ ok: true, ...page });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

type SaveBody = {
  url?: string;
  note?: string;
  category?: string;
  // Explicit post-type override from the manual "Save a post" dialog. When
  // omitted (e.g. a one-click swipe-file bookmark), the server auto-classifies
  // from the scraped post text. Anything other than the two known values is
  // ignored and treated as "auto".
  postType?: string;
};

// Resolve the post_type to store: an explicit, valid override wins; otherwise
// auto-classify from whatever post text we have (scraped > oEmbed snippet).
function resolvePostType(override: string | undefined, text: string | null): PostType {
  if (override === "regular" || override === "lead_magnet") return override;
  return classifyPost(text).post_type;
}

// -----------------------------------------------------------------------------
// POST /api/saved-posts  — save (or no-op upsert) a LinkedIn post by URL
// -----------------------------------------------------------------------------
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as SaveBody;
    const rawUrl = (body.url ?? "").trim();
    const note = (body.note ?? "").trim() || null;
    // Raw category from the client; validated against the canonical taxonomy
    // once we have a Supabase client below. Empty string means "no niche".
    const rawCategory = body.category;
    // Explicit override; validated/normalized by resolvePostType against the
    // scraped text once we have it.
    const postTypeOverride = body.postType;

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
    // The URN type as parsed from the pasted URL. Used to build a correct
    // "open on LinkedIn" URL when the id is a share/ugcPost id (which does NOT
    // resolve under urn:li:activity). The probed embed_urn is preferred over
    // this once we have it, since it's verified against the embed endpoint.
    const urnType = urn.type;

    // Optional `?share=<id>` puts this save into someone else's library
    // (a shared bookmarks library the caller has accepted an invite for).
    // When unset we write to the caller's own workspace.
    const shareId = new URL(req.url).searchParams.get("share");
    let active;
    try {
      active = await resolveActiveLibrary(shareId);
    } catch (e) {
      if (e instanceof SharedBookmarkAccessError) {
        return NextResponse.json({ ok: false, error: e.message }, { status: 404 });
      }
      throw e;
    }
    const { userId } = await auth();
    const sb = await scopedSupabase();

    // Validate the category against the canonical taxonomy. Unknown ids are
    // rejected so we don't store drift (a bogus id renders no chip on read,
    // but accepting it lets bad data accumulate). Empty/missing → null.
    const catResult = await validateCategoryId(sb.raw, rawCategory, active.workspaceId);
    if (!catResult.ok) {
      return NextResponse.json(
        { ok: false, error: `Unknown category: ${rawCategory}` },
        { status: 400 },
      );
    }
    const categoryId = catResult.categoryId;

    const canonical = canonicalPostUrl(activityId);
    const handleFromUrl = authorHandleFromUrl(rawUrl);

    // Idempotent: if THIS library already has this post, return the
    // existing row so the UI can just refresh and feel snappy. We
    // dedupe by (workspace_id, activity_id) — same regardless of which
    // contributor added it, so a recipient can't double-save the
    // owner's post.
    const { data: existing } = await sb.raw
      .from("saved_posts")
      .select(SELECT_COLS)
      .eq("workspace_id", active.workspaceId)
      .eq("activity_id", activityId)
      .maybeSingle();

    if (existing) {
      // Opportunistic backfill: rows saved before migration 017, or rows
      // whose embed_urn was set incorrectly by migration 018's URL-shape
      // heuristic, would otherwise 404 in the iframe forever. Re-paste is
      // the user's natural retry; honor it by re-probing when the stored
      // value is null. A failed probe leaves the row as-is — we don't
      // want a transient network error to wipe a working URN.
      // Re-paste is the user's natural retry. Backfill the native-render
      // columns when they're missing (rows saved before migration 026, or
      // whose scrape failed at save time). Re-probe the URN first if it's
      // null, then scrape from whichever URN we have.
      // Cheap, no-network repair: rows whose embed_urn is already correct but
      // whose post_url was written as the activity-shaped guess (the old
      // canonicalPostUrl path) for a share/ugcPost post — that URL 404s on
      // LinkedIn. Rebuild post_url from the verified URN. This runs even when
      // the native columns are fully populated (so re-pasting fixes the link
      // without needing a re-scrape).
      if (existing.embed_urn) {
        const repaired = postUrlFromUrn(existing.embed_urn);
        if (repaired && repaired !== existing.post_url) {
          const { data: relinked } = await sb.raw
            .from("saved_posts")
            .update({ post_url: repaired })
            .eq("id", existing.id)
            // Belt-and-suspenders: `id` came from a workspace-scoped lookup
            // above, but every mutation in this app stamps workspace_id so the
            // tenancy boundary is enforced at the query, not just by RLS.
            .eq("workspace_id", active.workspaceId)
            .select(SELECT_COLS)
            .single();
          if (relinked) existing.post_url = relinked.post_url;
        }
      }

      // Cheap, no-network backfill: rows saved before migration 032 (or whose
      // activity_id the migration's SQL guard skipped) have a null posted_at.
      // Decode it from the snowflake id so the publish date renders. Runs on
      // re-paste even when the native columns are already populated.
      if (existing.posted_at === null) {
        const derived = postedAtFromLinkedInId(existing.activity_id);
        if (derived) {
          const { data: dated } = await sb.raw
            .from("saved_posts")
            .update({ posted_at: derived })
            .eq("id", existing.id)
            .eq("workspace_id", active.workspaceId)
            .select(SELECT_COLS)
            .single();
          if (dated) existing.posted_at = dated.posted_at;
        }
      }

      const needsNative = existing.text === null && existing.embed_urn !== null;
      if (existing.embed_urn === null || needsNative) {
        const urn =
          existing.embed_urn ?? (await probeEmbedUrn(activityId)) ?? null;
        if (urn) {
          const card = await fetchEmbedCard(urn);
          const patch: Record<string, unknown> = { embed_urn: urn };
          // Repair a stale activity-shaped post_url written by the old
          // canonicalPostUrl() path: share/ugcPost posts stored a
          // urn:li:activity:<id> URL that 404s. Rebuild from the verified URN.
          const repairedUrl = postUrlFromUrn(urn);
          if (repairedUrl) patch.post_url = repairedUrl;
          if (card.text) {
            patch.text = card.text;
            // Now that we finally have the post text, auto-classify the
            // post_type for this older row (rows saved before migration 031
            // defaulted to 'regular'). An explicit override on the re-paste
            // still wins.
            patch.post_type = resolvePostType(postTypeOverride, card.text);
          }
          if (card.authorName) patch.author_name = card.authorName;
          if (card.profilePicUrl) patch.profile_pic_url = card.profilePicUrl;
          if (card.mediaType !== "none") {
            patch.media_type = card.mediaType;
            patch.media_urls = card.mediaUrls;
            // Backfill the direct video URL for older rows saved before this
            // column existed — re-paste is the natural retry.
            if (card.videoUrl) patch.video_url = card.videoUrl;
          }
          if (card.reactions !== null) patch.reactions = card.reactions;
          if (card.comments !== null) patch.comments = card.comments;
          const { data: updated } = await sb.raw
            .from("saved_posts")
            .update(patch)
            .eq("id", existing.id)
            // Same tenancy guard as the relink update above.
            .eq("workspace_id", active.workspaceId)
            .select(SELECT_COLS)
            .single();
          if (updated) {
            invalidateBookmarksSegment();
            return NextResponse.json({ ok: true, saved: updated, alreadySaved: true });
          }
        }
      }
      invalidateBookmarksSegment();
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
    // Native render data: fetch + parse the public embed page (free, no
    // Apify). Gives full text, profile pic, media, and live reaction/comment
    // counts. We only have a URN to scrape once oEmbed/probe resolves one;
    // if neither did, skip the scrape and fall back to oEmbed's snippet.
    const embedUrn = oembed.embedUrn ?? probedUrn ?? null;
    const card = embedUrn
      ? await fetchEmbedCard(embedUrn)
      : null;

    // The URL we store + render as "open on LinkedIn". Priority:
    //   1. Derived from the verified embed_urn — correct type, known to resolve.
    //   2. Built from the URN type we parsed off the pasted URL — correct for
    //      share/ugcPost posts whose id is NOT a valid activity id.
    //   3. The activity-shaped canonical (legacy fallback).
    // (2) is what fixes ugcPost/share posts that previously 404'd because we
    // always emitted urn:li:activity:<id> regardless of the real URN type.
    const openUrl =
      postUrlFromUrn(embedUrn) ?? postUrlForUrn(urnType, activityId);

    let handle = handleFromUrl;
    if (!handle && card?.profileUrl) {
      handle = authorHandleFromProfileUrl(card.profileUrl);
    }
    if (!handle && oembed.authorProfileUrl) {
      handle = authorHandleFromProfileUrl(oembed.authorProfileUrl);
    }
    if (!handle) {
      handle = await fetchHandleViaRedirect(canonical);
    }
    // Prefer the scraped author name (matches what renders), then oEmbed,
    // then a handle-derived guess.
    const authorName =
      card?.authorName ??
      oembed.authorName ??
      (handle ? displayNameFromHandle(handle) : null);

    const { data: inserted, error } = await sb.raw
      .from("saved_posts")
      .insert({
        // Use active.workspaceId so a save into a shared library lands
        // under the OWNER's workspace (the recipient is contributing,
        // not collecting in their own library). created_by_user_id
        // attributes the contribution.
        workspace_id: active.workspaceId,
        activity_id: activityId,
        post_url: openUrl,
        original_url: rawUrl,
        author_name: authorName,
        author_handle: handle,
        text_snippet: oembed.textSnippet,
        // Full native-render payload from the embed scrape. Nullable — a
        // failed scrape leaves these null and the card falls back to
        // text_snippet + "open on LinkedIn".
        text: card?.text ?? null,
        profile_pic_url: card?.profilePicUrl ?? null,
        media_type: card?.mediaType ?? "none",
        media_urls: card?.mediaUrls ?? [],
        // Direct .mp4 for video posts → lets the card play inline natively.
        video_url: card?.videoUrl ?? null,
        reactions: card?.reactions ?? null,
        comments: card?.comments ?? null,
        // Regular vs. lead-magnet. Explicit override from the manual dialog
        // wins; otherwise auto-classify from the scraped text (falling back to
        // the oEmbed snippet) — the same regex sweep the daily pipeline runs.
        post_type: resolvePostType(postTypeOverride, card?.text ?? oembed.textSnippet ?? null),
        // Original publish date, decoded for free from the activity id's
        // snowflake timestamp (no network call). Lets the bookmarks card show
        // the publish date the same way the swipe-file card does. Null when the
        // id isn't a plausible snowflake.
        posted_at: postedAtFromLinkedInId(activityId),
        // Priority: oEmbed (when present, authoritative since LinkedIn
        // itself generated the iframe) > probed URN (verified to return 200
        // from the embed endpoint). If both fail (LinkedIn rate-limited,
        // network blip, or genuinely deleted post), store null rather than
        // a URL-shape guess that's likely to 404. The "re-paste to retry"
        // path in the duplicate-save branch above will re-probe and update
        // the row when the user notices and tries again.
        embed_urn: embedUrn,
        note,
        category_id: categoryId,
        saved_by: userId ?? null,
        created_by_user_id: userId ?? null,
      })
      .select(SELECT_COLS)
      .single();

    if (error || !inserted) {
      // Treat unique-violation as "already saved" (race condition between two
      // concurrent saves of the same URL). Other errors propagate.
      if (error?.code === "23505") {
        const { data: row } = await sb.raw
          .from("saved_posts")
          .select(SELECT_COLS)
          .eq("workspace_id", active.workspaceId)
          .eq("activity_id", activityId)
          .maybeSingle();
        if (row) {
          invalidateBookmarksSegment();
          return NextResponse.json({ ok: true, saved: row, alreadySaved: true });
        }
      }
      throw error || new Error("insert failed");
    }

    invalidateBookmarksSegment();
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
    const shareId = url.searchParams.get("share");
    let active;
    try {
      active = await resolveActiveLibrary(shareId);
    } catch (e) {
      if (e instanceof SharedBookmarkAccessError) {
        return NextResponse.json({ ok: false, error: e.message }, { status: 404 });
      }
      throw e;
    }
    const sb = await scopedSupabase();

    // Look up the row first so we can authorize: in a shared library,
    // the recipient may only delete saves they added themselves
    // (created_by_user_id matches). The owner can always delete.
    const { data: row } = await sb.raw
      .from("saved_posts")
      .select("id, workspace_id, created_by_user_id")
      .eq("id", id)
      .eq("workspace_id", active.workspaceId)
      .maybeSingle();
    if (!row) {
      return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    }
    if (!canHardMutate(active, row)) {
      return NextResponse.json(
        { ok: false, error: "Only the owner or the original contributor can remove this." },
        { status: 403 },
      );
    }

    const { error } = await sb.raw
      .from("saved_posts")
      .delete()
      .eq("id", id)
      .eq("workspace_id", active.workspaceId);
    if (error) throw error;
    invalidateBookmarksSegment();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
