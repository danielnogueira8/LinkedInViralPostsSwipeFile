import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { z } from "zod";

export const runtime = "nodejs";

const pairSchema = z.object({
  min_reactions: z.number().int().min(0),
  min_comments: z.number().int().min(0),
});

const bodySchema = z.object({
  viral: pairSchema,
  template: pairSchema,
});

export async function GET() {
  const sb = supabaseAdmin();
  const { data } = await sb
    .from("settings")
    .select("key, value")
    .in("key", ["viral_thresholds", "template_thresholds"]);
  const byKey = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
  return NextResponse.json({
    ok: true,
    viral: byKey.viral_thresholds ?? { min_reactions: 200, min_comments: 50 },
    template: byKey.template_thresholds ?? { min_reactions: 500, min_comments: 100 },
  });
}

export async function POST(req: Request) {
  const body = await req.json();
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: false, error: parsed.error.message }, { status: 400 });
  const sb = supabaseAdmin();
  const now = new Date().toISOString();
  const { error } = await sb.from("settings").upsert([
    { key: "viral_thresholds", value: parsed.data.viral, updated_at: now },
    { key: "template_thresholds", value: parsed.data.template, updated_at: now },
  ]);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  // Re-evaluate is_viral against the swipe-file threshold for all stored posts.
  // (Template threshold is checked at template-generation time, no backfill needed.)
  const { data: posts } = await sb.from("posts").select("id, reactions, comments");
  if (posts) {
    for (const p of posts) {
      const isViral =
        p.reactions >= parsed.data.viral.min_reactions ||
        p.comments >= parsed.data.viral.min_comments;
      await sb.from("posts").update({ is_viral: isViral }).eq("id", p.id);
    }
  }
  return NextResponse.json({ ok: true });
}
