import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { classifyPost } from "@/lib/post-type";

export const runtime = "nodejs";
export const maxDuration = 300;

// One-shot reclassifier. Paginates through every post, runs the regex+ratio
// classifier, and writes back only when post_type or detected_via changed.
// Safe to re-run.
export async function POST() {
  const sb = supabaseAdmin();
  const pageSize = 1000;
  let from = 0;
  let scanned = 0;
  let updated = 0;

  while (true) {
    const { data, error } = await sb
      .from("posts")
      .select("id, text, reactions, comments, post_type, post_type_detected_via")
      .order("id")
      .range(from, from + pageSize - 1);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;

    for (const p of data) {
      scanned++;
      const { post_type, detected_via } = classifyPost(p.text, p.reactions, p.comments);
      if (post_type !== p.post_type || (detected_via ?? null) !== (p.post_type_detected_via ?? null)) {
        const { error: upErr } = await sb
          .from("posts")
          .update({ post_type, post_type_detected_via: detected_via })
          .eq("id", p.id);
        if (!upErr) updated++;
      }
    }

    if (data.length < pageSize) break;
    from += pageSize;
  }

  return NextResponse.json({ ok: true, scanned, updated });
}
