import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { z } from "zod";

export const runtime = "nodejs";

const tSchema = z.object({
  min_reactions: z.number().int().min(0),
  min_comments: z.number().int().min(0),
});

export async function GET() {
  const sb = supabaseAdmin();
  const { data } = await sb.from("settings").select("value").eq("key", "viral_thresholds").maybeSingle();
  return NextResponse.json({ ok: true, thresholds: data?.value ?? { min_reactions: 200, min_comments: 50 } });
}

export async function POST(req: Request) {
  const body = await req.json();
  const parsed = tSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: false, error: parsed.error.message }, { status: 400 });
  const sb = supabaseAdmin();
  const { error } = await sb.from("settings").upsert({
    key: "viral_thresholds",
    value: parsed.data,
    updated_at: new Date().toISOString(),
  });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const { data: posts } = await sb.from("posts").select("id, reactions, comments");
  if (posts) {
    const updates = posts.map((p) => ({
      id: p.id,
      is_viral: p.reactions >= parsed.data.min_reactions || p.comments >= parsed.data.min_comments,
    }));
    for (const u of updates) await sb.from("posts").update({ is_viral: u.is_viral }).eq("id", u.id);
  }
  return NextResponse.json({ ok: true });
}
