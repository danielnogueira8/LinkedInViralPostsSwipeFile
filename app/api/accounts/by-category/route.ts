import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { z } from "zod";

export const runtime = "nodejs";

const bodySchema = z.object({
  category_ids: z.array(z.string()).min(1),
  action: z.enum(["track", "untrack"]),
});

export async function POST(req: Request) {
  try {
    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: parsed.error.message }, { status: 400 });
    }
    const { category_ids, action } = parsed.data;
    const sb = await scopedSupabase();

    const { data: accountRows, error: selErr } = await sb.raw
      .from("accounts")
      .select("id")
      .in("category_id", category_ids);
    if (selErr) throw selErr;
    const accountIds = (accountRows ?? []).map((r) => r.id as string);

    if (accountIds.length === 0) {
      return NextResponse.json({ ok: true, affected: 0 });
    }

    if (action === "track") {
      const rows = accountIds.map((account_id) => ({
        workspace_id: sb.workspaceId,
        account_id,
        niche: null,
      }));
      const { error } = await sb.raw
        .from("workspace_accounts")
        .upsert(rows, { onConflict: "workspace_id,account_id" });
      if (error) throw error;
    } else {
      const { error } = await sb.raw
        .from("workspace_accounts")
        .delete()
        .eq("workspace_id", sb.workspaceId)
        .in("account_id", accountIds);
      if (error) throw error;
    }

    return NextResponse.json({ ok: true, affected: accountIds.length });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
