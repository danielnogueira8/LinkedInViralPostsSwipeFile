import { NextResponse } from "next/server";
import { scopedSupabase, trackedAccountIds } from "@/lib/supabase-scoped";
import { templatizePost, setAnthropicKey } from "@/lib/claude";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  setAnthropicKey(process.env.SWIPE_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY);
  const { postId } = await req.json();
  if (!postId) return NextResponse.json({ ok: false, error: "postId required" }, { status: 400 });
  const sb = await scopedSupabase();

  // Authz: the workspace must track this post's account.
  const accountIds = await trackedAccountIds(sb.workspaceId);
  if (accountIds.length === 0) {
    return NextResponse.json({ ok: false, error: "post not found" }, { status: 404 });
  }
  const { data: post } = await sb.raw
    .from("posts")
    .select("id, text, account_id")
    .eq("id", postId)
    .in("account_id", accountIds)
    .maybeSingle();
  if (!post?.text) return NextResponse.json({ ok: false, error: "post has no text" }, { status: 404 });

  // Idempotency / cost guard: if this post already has a template, return it
  // instead of calling Claude again. templatizePost is a paid Anthropic call,
  // and the result is deterministic enough that regenerating wastes spend.
  // The UI normally hides "Generate" once a template exists, but a second
  // mounted card for the same post (swipe deck + grid) or a direct/retried
  // request could still hit this endpoint — so we dedupe server-side rather
  // than overwriting the stored template with an identical fresh generation.
  const { data: cached } = await sb.raw
    .from("templates")
    .select("*")
    .eq("post_id", postId)
    .maybeSingle();
  if (cached) {
    return NextResponse.json({ ok: true, template: cached, cached: true });
  }

  try {
    const tpl = await templatizePost(post.text);
    const { data, error } = await sb.raw.from("templates").upsert(
      { post_id: postId, template_text: tpl, model: "claude-haiku-4-5-20251001", generated_at: new Date().toISOString() },
      { onConflict: "post_id" },
    ).select().single();
    if (error) throw error;
    return NextResponse.json({ ok: true, template: data });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
