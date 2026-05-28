import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { handleFromUrl } from "@/lib/sheets";

export const runtime = "nodejs";

type Body = {
  profile_url?: string;
  name?: string;
  category_id?: string | null;
};

// Normalize a LinkedIn profile URL so dupes like "linkedin.com/in/foo" and
// "linkedin.com/in/foo/" collapse to one row.
function normalizeProfileUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/linkedin\.com\/in\/([^\/\?#]+)/i);
  if (!m) return null;
  return `https://www.linkedin.com/in/${m[1].toLowerCase()}`;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const url = body.profile_url ? normalizeProfileUrl(body.profile_url) : null;
    const name = (body.name ?? "").trim();
    if (!url) return NextResponse.json({ ok: false, error: "Invalid LinkedIn profile URL" }, { status: 400 });
    if (!name) return NextResponse.json({ ok: false, error: "Name is required" }, { status: 400 });

    const sb = await scopedSupabase();
    const handle = handleFromUrl(url);
    const rawCategoryId = body.category_id?.trim() || null;

    // Cap: each workspace may manually add at most 50 creators.
    // Sheet-sourced accounts don't count toward this limit.
    // Join workspace_accounts → accounts to count only manual tracked accounts
    // for this specific workspace.
    const { data: trackedManual } = await sb.raw
      .from("workspace_accounts")
      .select("accounts!inner(source)")
      .eq("workspace_id", sb.workspaceId)
      .eq("accounts.source", "manual");
    if ((trackedManual ?? []).length >= 50) {
      return NextResponse.json(
        { ok: false, error: "You've reached the 50 manually-added creator limit." },
        { status: 400 },
      );
    }

    // Validate category against the canonical taxonomy. Unknown ids are
    // rejected so we never reintroduce drift through the manual flow.
    let categoryId: string | null = null;
    let niche: string | null = null;
    if (rawCategoryId) {
      const { data: cat } = await sb.raw
        .from("categories")
        .select("id, label")
        .eq("id", rawCategoryId)
        .maybeSingle();
      if (!cat) {
        return NextResponse.json(
          { ok: false, error: `Unknown category: ${rawCategoryId}` },
          { status: 400 },
        );
      }
      categoryId = cat.id as string;
      niche = cat.label as string; // keep accounts.niche in sync with the canonical label
    }

    // 1. Upsert the global account (idempotent — service-role bypasses RLS write rule).
    //    Source stays "manual" only if it's new; existing sheet accounts keep their source.
    const { data: existing } = await sb.raw
      .from("accounts")
      .select("id, source")
      .eq("profile_url", url)
      .maybeSingle();

    let accountId: string;
    if (existing) {
      accountId = existing.id;
      // If the caller picked a category and the existing row doesn't have one,
      // backfill so the creator shows up in the rail immediately. Don't
      // clobber a non-null category — that's another workspace's call.
      if (categoryId) {
        await sb.raw
          .from("accounts")
          .update({ category_id: categoryId, niche })
          .eq("id", accountId)
          .is("category_id", null);
      }
    } else {
      const { data: created, error } = await sb.raw
        .from("accounts")
        .insert({
          name,
          profile_url: url,
          linkedin_handle: handle,
          niche,
          category_id: categoryId,
          source: "manual",
          synced_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (error || !created) throw error || new Error("insert failed");
      accountId = created.id;
    }

    // 2. Track for this workspace. We deliberately do NOT pass a per-workspace
    //    niche override — the global account.niche/category_id is the source
    //    of truth. (workspace_accounts.niche is reserved for future per-team
    //    relabeling and stays NULL by default.)
    const { error: trackErr } = await sb.trackAccount(accountId, null);
    if (trackErr) throw trackErr;

    return NextResponse.json({ ok: true, account: { id: accountId, name, source: existing?.source ?? "manual" } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });

    const sb = await scopedSupabase();

    // Authorization: the caller must actually track this account from
    // their workspace. `accounts` is a global table — without this check,
    // workspace B could DELETE a manual account workspace A created and
    // soft-archive it for everyone. Check workspace_accounts first; if
    // there's no membership row, treat it as "not found" to avoid leaking
    // existence of accounts owned by other workspaces.
    const { data: membership } = await sb
      .workspaceAccountsSelect("account_id")
      .eq("account_id", id)
      .maybeSingle();
    if (!membership) {
      return NextResponse.json({ ok: false, error: "Account not found" }, { status: 404 });
    }

    // Only manual (UI-added) accounts can be deleted from the picker. Sheet-sourced
    // accounts are shared catalog rows — removing one would yank it from every
    // workspace, so those go through untrack instead.
    const { data: acct } = await sb.raw
      .from("accounts")
      .select("id, source")
      .eq("id", id)
      .maybeSingle();
    if (!acct) return NextResponse.json({ ok: false, error: "Account not found" }, { status: 404 });
    if (acct.source !== "manual") {
      return NextResponse.json(
        { ok: false, error: "Only manually-added creators can be deleted. Untrack this one instead." },
        { status: 400 },
      );
    }

    // Untrack first so workspace_accounts is clean, then soft-delete the global
    // account row. Posts stay (FK is on delete cascade against a hard delete,
    // but soft-delete preserves history; all read paths filter archived_at).
    const { error: untrackErr } = await sb.untrackAccount(id);
    if (untrackErr) throw untrackErr;

    const { error: archiveErr } = await sb.raw
      .from("accounts")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", id);
    if (archiveErr) throw archiveErr;

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
