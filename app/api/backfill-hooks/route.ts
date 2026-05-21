import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import {
  setAnthropicKey,
  extractHookWithClaude,
  classifyHookPattern,
} from "@/lib/claude";
import { extractHookHeuristic } from "@/lib/hooks";
import { requireWorkspaceId } from "@/lib/workspace";

export const runtime = "nodejs";
export const maxDuration = 800;

export async function POST() {
  await requireWorkspaceId();
  setAnthropicKey(process.env.SWIPE_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY);

  const sb = supabaseAdmin();

  // All viral posts with text. Hooks live globally on posts (not per
  // workspace), so we backfill across the table — workspace-scoping
  // happens at read time on the page.
  const { data: viral, error } = await sb
    .from("posts")
    .select("id, text")
    .eq("is_viral", true)
    .not("text", "is", null);
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  const candidates = (viral ?? []).filter((p) => !!p.text);
  const ids = candidates.map((p) => p.id);
  const { data: existing } = ids.length
    ? await sb.from("hooks").select("post_id").in("post_id", ids)
    : { data: [] as { post_id: string }[] };
  const have = new Set((existing ?? []).map((e) => e.post_id));
  const todo = candidates.filter((p) => !have.has(p.id));

  let extracted = 0;
  let viaHeuristic = 0;
  let viaClaude = 0;
  let errors = 0;

  for (const p of todo) {
    try {
      const heuristic = extractHookHeuristic(p.text as string);
      if (heuristic) {
        let pattern: string | null = null;
        try {
          pattern = await classifyHookPattern(heuristic);
        } catch (e) {
          console.warn("hook pattern classify fail", p.id, (e as Error).message);
        }
        await sb.from("hooks").insert({
          post_id: p.id,
          hook_text: heuristic,
          pattern_tag: pattern,
          extracted_via: "heuristic",
        });
        viaHeuristic++;
      } else {
        const { hook, pattern } = await extractHookWithClaude(p.text as string);
        await sb.from("hooks").insert({
          post_id: p.id,
          hook_text: hook,
          pattern_tag: pattern,
          extracted_via: "claude",
        });
        viaClaude++;
      }
      extracted++;
    } catch (e) {
      console.error("backfill hook fail", p.id, (e as Error).message);
      errors++;
    }
  }

  return NextResponse.json({
    ok: true,
    total: todo.length,
    extracted,
    viaHeuristic,
    viaClaude,
    errors,
  });
}
