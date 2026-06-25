import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { z } from "zod";

export const runtime = "nodejs";

const bodySchema = z.object({
  // category ids are short text slugs (e.g. "ai", "seo"). Bound each id's length
  // and cap the array so one request can't pass an unbounded list into the
  // `.in(...)` filter. (Not uuids — categories.id is a text slug.)
  category_ids: z.array(z.string().min(1).max(100)).min(1).max(200),
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

    let accountQuery = sb.raw
      .from("accounts")
      .select("id")
      .in("category_id", category_ids);
    // For TRACK, skip soft-deleted creators: a workspace_accounts row for an
    // archived account renders nowhere (every read path filters
    // `archived_at is null`), so it's dangling state — the single
    // accounts/track route rejects archived accounts for the same reason.
    // For UNTRACK we keep them, so a membership left over from before the
    // account was archived can still be cleaned up.
    if (action === "track") {
      accountQuery = accountQuery.is("archived_at", null);
    }
    const { data: accountRows, error: selErr } = await accountQuery;
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
