import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { z } from "zod";

export const runtime = "nodejs";

const bodySchema = z.object({
  category_ids: z.array(z.string()).optional().default([]),
});

export async function POST(req: Request) {
  try {
    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: parsed.error.message }, { status: 400 });
    }
    const { category_ids } = parsed.data;
    const sb = await scopedSupabase();

    let tracked = 0;
    if (category_ids.length > 0) {
      const { data: rows, error: selErr } = await sb.raw
        .from("accounts")
        .select("id")
        .in("category_id", category_ids);
      if (selErr) throw selErr;
      const accountIds = (rows ?? []).map((r) => r.id as string);
      if (accountIds.length > 0) {
        const upserts = accountIds.map((account_id) => ({
          workspace_id: sb.workspaceId,
          account_id,
          niche: null,
        }));
        const { error: trackErr } = await sb.raw
          .from("workspace_accounts")
          .upsert(upserts, { onConflict: "workspace_id,account_id" });
        if (trackErr) throw trackErr;
        tracked = accountIds.length;
      }
    }

    const { error: setErr } = await sb.upsertSetting("onboarded_at", {
      at: new Date().toISOString(),
    });
    if (setErr) throw setErr;

    return NextResponse.json({ ok: true, tracked });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
