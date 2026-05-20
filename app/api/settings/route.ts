import { NextResponse } from "next/server";
import { scopedSupabase, trackedAccountIds } from "@/lib/supabase-scoped";
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
  const sb = await scopedSupabase();
  const { data } = await sb
    .settings()
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
  const sb = await scopedSupabase();

  const [r1, r2] = await Promise.all([
    sb.upsertSetting("viral_thresholds", parsed.data.viral),
    sb.upsertSetting("template_thresholds", parsed.data.template),
  ]);
  if (r1.error || r2.error) {
    return NextResponse.json({ ok: false, error: (r1.error || r2.error)!.message }, { status: 500 });
  }

  // Re-evaluate is_viral for posts from accounts THIS workspace tracks.
  // `is_viral` is global today; this still works for the single-workspace
  // case and remains the right behavior since each scrape is global anyway.
  // (Future: per-workspace is_viral as a derived view rather than a column.)
  const accountIds = await trackedAccountIds(sb.workspaceId);
  if (accountIds.length > 0) {
    const { data: posts } = await sb.raw
      .from("posts")
      .select("id, reactions, comments")
      .in("account_id", accountIds);
    if (posts) {
      for (const p of posts) {
        const isViral =
          p.reactions >= parsed.data.viral.min_reactions ||
          p.comments >= parsed.data.viral.min_comments;
        await sb.raw.from("posts").update({ is_viral: isViral }).eq("id", p.id);
      }
    }
  }
  return NextResponse.json({ ok: true });
}
