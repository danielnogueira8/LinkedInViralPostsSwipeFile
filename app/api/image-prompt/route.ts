import { NextResponse } from "next/server";
import { scopedSupabase, trackedAccountIds } from "@/lib/supabase-scoped";
import { imagePrompt, classifyVisual, setAnthropicKey } from "@/lib/claude";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  setAnthropicKey(process.env.SWIPE_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY);
  const { postId, clientId } = await req.json();
  if (!postId || !clientId) return NextResponse.json({ ok: false, error: "postId and clientId required" }, { status: 400 });
  const sb = await scopedSupabase();

  // Authz: client must belong to this workspace.
  const { data: client } = await sb
    .clientsSelect("id, name, brand_colors")
    .eq("id", clientId)
    .maybeSingle();
  if (!client) return NextResponse.json({ ok: false, error: "client not found" }, { status: 404 });

  // Authz: post must be from an account this workspace tracks.
  const accountIds = await trackedAccountIds(sb.workspaceId);
  if (accountIds.length === 0) {
    return NextResponse.json({ ok: false, error: "post not found" }, { status: 404 });
  }

  const { data: cached } = await sb
    .imagePromptsSelect("prompt_text")
    .eq("post_id", postId)
    .eq("client_id", clientId)
    .maybeSingle();
  if (cached) return NextResponse.json({ ok: true, prompt: cached.prompt_text, cached: true });

  const { data: post } = await sb.raw
    .from("posts")
    .select("id, media_type, media_urls, visual_kind, account_id")
    .eq("id", postId)
    .in("account_id", accountIds)
    .maybeSingle();
  if (!post) return NextResponse.json({ ok: false, error: "post not found" }, { status: 404 });
  if (post.media_type !== "image" || !Array.isArray(post.media_urls) || post.media_urls.length === 0) {
    return NextResponse.json({ ok: false, error: "post has no image" }, { status: 400 });
  }

  const imageUrl = post.media_urls[0] as string;

  try {
    if (!post.visual_kind) {
      const kind = await classifyVisual(imageUrl);
      await sb.raw.from("posts").update({ visual_kind: kind }).eq("id", postId);
      if (kind !== "graphic") {
        return NextResponse.json({ ok: false, error: "image classified as photo, not a recreatable graphic" }, { status: 400 });
      }
    }

    const prompt = await imagePrompt(imageUrl, (client.brand_colors as { name?: string; hex: string }[]) || [], client.name);
    await sb.upsertImagePrompt({ post_id: postId, client_id: clientId, prompt_text: prompt });
    return NextResponse.json({ ok: true, prompt, cached: false });
  } catch (e) {
    const err = e as Error;
    // Untrusted image URLs (non-LinkedIn-CDN, non-https) are a client
    // error, not a server error. Surface as 400 so the UI can show a
    // useful message instead of a generic 500.
    const status = err.name === "UntrustedImageUrlError" ? 400 : 500;
    return NextResponse.json({ ok: false, error: err.message }, { status });
  }
}
