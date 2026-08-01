import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { errorResponse, requireWorkspaceId } from "@/lib/workspace";
import { isAdmin } from "@/lib/admin";
import { classifyPost } from "@/lib/post-type";

export const runtime = "nodejs";
export const maxDuration = 300;

// One-shot reclassifier. Paginates through every post, runs the regex+ratio
// classifier, and writes back only when post_type or detected_via changed.
// Safe to re-run. Globally scoped — admin only since the writes hit every
// workspace's posts.
export async function POST() {
  try {
    await requireWorkspaceId();
    if (!(await isAdmin())) {
      return NextResponse.json({ ok: false, error: "Admin only." }, { status: 403 });
    }
    const sb = supabaseAdmin();
    const pageSize = 1000;
    let from = 0;
    let scanned = 0;
    let updated = 0;

  while (true) {
    const { data, error } = await sb
      .from("posts")
      .select("id, text, post_type, post_type_detected_via")
      .order("id")
      .range(from, from + pageSize - 1);
    if (error) return errorResponse(error);
    if (!data || data.length === 0) break;

    for (const p of data) {
      scanned++;
      const { post_type, detected_via } = classifyPost(p.text);
      if (post_type !== p.post_type || (detected_via ?? null) !== (p.post_type_detected_via ?? null)) {
        const { error: upErr } = await sb
          .from("posts")
          .update({ post_type, post_type_detected_via: detected_via })
          .eq("id", p.id);
        if (upErr) return errorResponse(upErr);
        updated++;
      }
    }

    if (data.length < pageSize) break;
    from += pageSize;
  }

    return NextResponse.json({ ok: true, scanned, updated });
  } catch (e) {
    return errorResponse(e);
  }
}
