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

    // Auto-track the full catalog only on the FIRST sync (when this
    // workspace tracks nothing). Subsequent syncs respect the user's
    // curated list — previously we re-tracked every sheet account on every
    // sync, silently undoing untracks and dragging unwanted creators back
    // into the dashboard.
    const { count: tracked } = await sb.raw
      .from("workspace_accounts")
      .select("account_id", { count: "exact", head: true })
      .eq("workspace_id", sb.workspaceId);
    let autoTracked = 0;
    if ((tracked ?? 0) === 0) {
      // Exclude archived accounts: an archived global account shouldn't be
      // auto-tracked back into a fresh workspace on its first sync.
      const { data: sheetAccounts } = await sb.raw
        .from("accounts")
        .select("id")
        .eq("source", "sheet")
        .is("archived_at", null);
      if (sheetAccounts && sheetAccounts.length > 0) {
        await sb.raw.from("workspace_accounts").upsert(
          sheetAccounts.map((a) => ({ workspace_id: sb.workspaceId, account_id: a.id })),
          { onConflict: "workspace_id,account_id", ignoreDuplicates: true },
        );
        autoTracked = sheetAccounts.length;
      }
    }

    return NextResponse.json({ ok: true, count, skipped, at, autoTracked });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
