import { NextResponse } from "next/server";
import { syncAccountsFromSheet } from "@/lib/sheets";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { isAdmin } from "@/lib/admin";

export const runtime = "nodejs";

export async function POST() {
  try {
    if (!(await isAdmin())) {
      return NextResponse.json({ ok: false, error: "Admin only." }, { status: 403 });
    }
    const sb = await scopedSupabase();
    const { count, skipped, at } = await syncAccountsFromSheet();

    // After syncing the global accounts catalog, ensure every sheet-sourced
    // account is tracked by this workspace (so the "Sync sheet" button feels
    // like it added accounts for THIS workspace, even though the row is global).
    const { data: sheetAccounts } = await sb.raw
      .from("accounts")
      .select("id")
      .eq("source", "sheet");
    if (sheetAccounts && sheetAccounts.length > 0) {
      await sb.raw.from("workspace_accounts").upsert(
        sheetAccounts.map((a) => ({ workspace_id: sb.workspaceId, account_id: a.id })),
        { onConflict: "workspace_id,account_id", ignoreDuplicates: true },
      );
    }

    return NextResponse.json({ ok: true, count, skipped, at });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
