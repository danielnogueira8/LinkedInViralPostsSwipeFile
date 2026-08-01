import { NextResponse } from "next/server";
import { scopedSupabase, trackedAccountIds } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { resolveModelSourcePostType } from "@/lib/post-type";

export const runtime = "nodejs";

const NO_ROWS_SENTINEL = "00000000-0000-0000-0000-000000000000";

// Resolve the canonical LinkedIn URL of the post a stashed source came from, by
// looking it up live from its origin table (swipe → posts, bookmark →
// saved_posts; drafts/templates have no LinkedIn origin). Looked up at read
// time rather than stored on the stash row, so no column is needed and the URL
// always matches the current row. Null when the underlying post is gone — the
// chip just renders without a link.
async function sourcePostUrl(
  sb: Awaited<ReturnType<typeof scopedSupabase>>,
  source: string,
  sourcePostId: string | null,
): Promise<string | null> {
  if (!sourcePostId) return null;
  if (source === "swipe") {
    const accountIds = await trackedAccountIds(sb.workspaceId);
    const { data, error } = await sb.raw
      .from("posts")
      .select("post_url")
      .eq("id", sourcePostId)
      .in("account_id", accountIds.length ? accountIds : [NO_ROWS_SENTINEL])
      .maybeSingle();
    if (error) throw error;
    return (data?.post_url as string | null) ?? null;
  }
  if (source === "bookmark") {
    const { data, error } = await sb.raw
      .from("saved_posts")
      .select("post_url")
      .eq("id", sourcePostId)
      .eq("workspace_id", sb.workspaceId)
      .maybeSingle();
    if (error) throw error;
    return (data?.post_url as string | null) ?? null;
  }
  return null;
}

// -----------------------------------------------------------------------------
// GET /api/model-source/[id] — fetch a stashed post to model after. The chat
// calls this when it sees ?model=<id>, to render the source-post chip and load
// the full text into the modeling prompt.
// -----------------------------------------------------------------------------
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const sb = await scopedSupabase();
    const { data, error } = await sb.raw
      .from("chat_modeling_sources")
      // source_post_id: for a 'draft' source this is the chat_artifacts row the
      // post was refined FROM, so saving the refined version can update the
      // original instead of creating a duplicate.
      .select(
        "id, post_text, author_name, author_avatar, source, source_post_id, post_type, partial, created_at",
      )
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return NextResponse.json({ ok: false, error: "Source not found" }, { status: 404 });
    }
    const postUrl = await sourcePostUrl(
      sb,
      data.source as string,
      (data.source_post_id as string | null) ?? null,
    );
    return NextResponse.json({
      ok: true,
      source: {
        ...data,
        post_url: postUrl,
        post_type: resolveModelSourcePostType(
          data.post_type,
          (data.post_text as string | null) ?? "",
        ),
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
