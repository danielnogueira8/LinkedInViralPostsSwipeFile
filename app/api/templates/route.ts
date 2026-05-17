import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { templatizePost, setAnthropicKey } from "@/lib/claude";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  setAnthropicKey(process.env.SWIPE_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY);
  const { postId } = await req.json();
  if (!postId) return NextResponse.json({ ok: false, error: "postId required" }, { status: 400 });
  const sb = supabaseAdmin();
  const { data: post } = await sb.from("posts").select("id, text").eq("id", postId).single();
  if (!post?.text) return NextResponse.json({ ok: false, error: "post has no text" }, { status: 404 });
  try {
    const tpl = await templatizePost(post.text);
    const { data, error } = await sb.from("templates").upsert(
      { post_id: postId, template_text: tpl, model: "claude-haiku-4-5-20251001", generated_at: new Date().toISOString() },
      { onConflict: "post_id" },
    ).select().single();
    if (error) throw error;
    return NextResponse.json({ ok: true, template: data });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
