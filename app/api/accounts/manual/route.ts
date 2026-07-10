import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { handleFromUrl } from "@/lib/sheets";
import { fetchProfileMeta, displayNameFromHandle } from "@/lib/linkedin-url";
import {
  isManualAccountLimitError,
  MANUAL_ACCOUNT_LIMIT,
  MANUAL_ACCOUNT_LIMIT_MESSAGE,
} from "@/lib/account-tracking";

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
    // Name is now OPTIONAL — if the caller doesn't supply one, we resolve it
    // for free (no Apify) from the profile's og:title below, falling back to a
    // slug-derived name. A caller-supplied name always wins.
    const suppliedName = (body.name ?? "").trim();
    if (!url) return NextResponse.json({ ok: false, error: "Invalid LinkedIn profile URL" }, { status: 400 });

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
    if ((trackedManual ?? []).length >= MANUAL_ACCOUNT_LIMIT) {
      return NextResponse.json(
        { ok: false, error: MANUAL_ACCOUNT_LIMIT_MESSAGE },
        { status: 409 },
      );
    }

    // Validate the category. Accept either a curated/global category
    // (workspace_id IS NULL) or one of THIS workspace's own custom categories.
    // A custom category id belonging to another workspace must be rejected so a
    // workspace can't write a foreign label onto the global accounts row that
    // everyone reads. Unknown ids are rejected so we never reintroduce drift
    // through the manual flow.
    let categoryId: string | null = null;
    let niche: string | null = null;
    if (rawCategoryId) {
      const { data: cat } = await sb.raw
        .from("categories")
        .select("id, label, workspace_id")
        .eq("id", rawCategoryId)
        .maybeSingle();
      const allowed = cat && (cat.workspace_id === null || cat.workspace_id === sb.workspaceId);
      if (!allowed) {
        return NextResponse.json(
          { ok: false, error: `Unknown category: ${rawCategoryId}` },
          { status: 400 },
        );
      }
      categoryId = cat.id as string;
      niche = cat.label as string; // keep accounts.niche in sync with the category label
    }

    // 1. Look up the global account first (idempotent — service-role bypasses
    //    the RLS write rule). Source stays "manual" only if it's new; existing
    //    sheet accounts keep their source.
    const { data: existing } = await sb.raw
      .from("accounts")
      .select("id, source, profile_pic_url, archived_at, manual_owner_workspace_id")
      .eq("profile_url", url)
      .maybeSingle();

    // Duplicate guard: reject when this workspace ALREADY tracks an *active*
    // (not soft-deleted) account at this exact normalized URL. Without this,
    // re-adding a creator silently re-ran the whole upsert + track path and
    // toasted "Added X" again, so users couldn't tell a creator was already in
    // their swipe file. We only block the active case — an archived row should
    // still resurrect on re-add (handled below), and an account that exists
    // globally but isn't tracked *here* is a legitimate add for this workspace.
    if (existing && !existing.archived_at) {
      const { data: alreadyTracked } = await sb
        .workspaceAccountsSelect("account_id")
        .eq("account_id", existing.id)
        .maybeSingle();
      if (alreadyTracked) {
        return NextResponse.json(
          { ok: false, error: "You're already tracking this creator.", code: "duplicate" },
          { status: 409 },
        );
      }
    }

    if (
      existing &&
      rawCategoryId &&
      existing.manual_owner_workspace_id !== sb.workspaceId
    ) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "This creator is shared from another workspace. Add it without changing its global category.",
        },
        { status: 409 },
      );
    }

    // Best-effort NAME + photo lookup from just the URL, in ONE request (free,
    // no Apify). og:title gives the display name, og:image the avatar. Never
    // throws; returns nulls on a block/timeout/private profile. Done only after
    // the dup check so we don't burn a network round-trip on a creator we're
    // about to reject.
    const meta = await fetchProfileMeta(url);
    const profilePicUrl = meta.picUrl;
    // Resolve the final name: caller-supplied wins; else the fetched og:title;
    // else a slug-derived guess from the handle (always non-empty). The daily
    // sync corrects it later if the guess is off.
    const name =
      suppliedName || meta.name || displayNameFromHandle(handle) || handle;
    // Did the free profile-metadata fetch actually resolve real details (a
    // name or an avatar)? The client uses this to pick between the confident
    // "Added {name}" copy and the softer "Added from URL. Profile details will
    // update later." message when LinkedIn blocked/timed out the preview fetch.
    // A caller-supplied name doesn't count as "resolved from the profile".
    const metaResolved = Boolean(meta.name || meta.picUrl);

    let accountId: string;
    if (existing) {
      accountId = existing.id;
      // Resurrect a soft-deleted row. Deleting a creator sets archived_at and
      // untracks it; without clearing archived_at on re-add, the account stays
      // invisible (every read path filters `archived_at is null`) even though
      // we then re-track it below — so it looks like the add silently failed.
      // Bump synced_at too so it doesn't render as stale ("—") until the next
      // pull. Only touch rows that are actually archived to avoid a needless
      // write on the common "re-add an active creator" path.
      if (existing.archived_at && existing.manual_owner_workspace_id !== sb.workspaceId) {
        return NextResponse.json(
          {
            ok: false,
            error: "This creator was archived by its original workspace and can't be restored here.",
          },
          { status: 409 },
        );
      }
      if (existing.archived_at) {
        await sb.raw
          .from("accounts")
          .update({ archived_at: null, synced_at: new Date().toISOString() })
          .eq("id", accountId);
      }
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
      // Backfill the avatar if this catalog row never got one (e.g. a manual
      // add from before this feature, or a sheet row the sync hasn't touched).
      // Guarded on null so we don't overwrite a fresher pic the sync stored.
      if (
        profilePicUrl &&
        !existing.profile_pic_url &&
        existing.manual_owner_workspace_id === sb.workspaceId
      ) {
        await sb.raw
          .from("accounts")
          .update({ profile_pic_url: profilePicUrl })
          .eq("id", accountId)
          .is("profile_pic_url", null);
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
          profile_pic_url: profilePicUrl,
          source: "manual",
          manual_owner_workspace_id: sb.workspaceId,
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
    if (isManualAccountLimitError(trackErr)) {
      // A parallel add may have consumed the final slot after the fast precheck.
      // Keep a newly-created global catalog row: deleting it here could race a
      // different workspace that already started tracking the shared account.
      return NextResponse.json(
        { ok: false, error: MANUAL_ACCOUNT_LIMIT_MESSAGE },
        { status: 409 },
      );
    }
    if (trackErr) throw trackErr;

    return NextResponse.json({
      ok: true,
      account: { id: accountId, name, source: existing?.source ?? "manual" },
      meta_resolved: metaResolved,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

type PatchBody = {
  id?: string;
  name?: string;
  // Tri-state on the wire:
  //   undefined        → field not sent, leave category unchanged
  //   null / ""        → clear category (uncategorized)
  //   "<id>"           → set to this category
  category_id?: string | null;
};

// Edit a manually-added creator's name and/or category.
//
// Only `source='manual'` accounts the caller's workspace tracks are editable —
// same authorization as DELETE. `accounts` is global, so editing a sheet-sourced
// catalog row would change it for every workspace; those stay read-only. The
// name/category here live on the global row (mirroring how the manual-add flow
// already writes them), consistent with delete's risk model.
export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as PatchBody;
    const id = (body.id ?? "").trim();
    if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });

    // Decide which fields the caller actually wants to change. `name` is only
    // touched when a non-empty value is sent; `category_id` is touched whenever
    // the key is present (so null/"" can clear it).
    const nameProvided = typeof body.name === "string";
    const name = nameProvided ? (body.name as string).trim() : null;
    if (nameProvided && !name) {
      return NextResponse.json({ ok: false, error: "Name can't be empty" }, { status: 400 });
    }
    const categoryProvided = "category_id" in body;

    if (!nameProvided && !categoryProvided) {
      return NextResponse.json({ ok: false, error: "Nothing to update" }, { status: 400 });
    }

    const sb = await scopedSupabase();

    // Authorization: must be tracked by this workspace (else "not found", so we
    // don't leak existence of other workspaces' accounts).
    const { data: membership } = await sb
      .workspaceAccountsSelect("account_id")
      .eq("account_id", id)
      .maybeSingle();
    if (!membership) {
      return NextResponse.json({ ok: false, error: "Account not found" }, { status: 404 });
    }

    // Only manual accounts are editable. Sheet-sourced rows are shared catalog.
    const { data: acct } = await sb.raw
      .from("accounts")
      .select("id, source, manual_owner_workspace_id")
      .eq("id", id)
      .maybeSingle();
    if (!acct) return NextResponse.json({ ok: false, error: "Account not found" }, { status: 404 });
    if (acct.source !== "manual") {
      return NextResponse.json(
        { ok: false, error: "Only manually-added creators can be edited." },
        { status: 400 },
      );
    }
    if (acct.manual_owner_workspace_id !== sb.workspaceId) {
      return NextResponse.json(
        {
          ok: false,
          error: "This shared creator can only be edited by its original workspace.",
        },
        { status: 409 },
      );
    }

    const update: Record<string, unknown> = {};
    if (nameProvided) update.name = name;

    if (categoryProvided) {
      const rawCategoryId = body.category_id?.trim() || null;
      if (!rawCategoryId) {
        // Clear the category. Keep accounts.niche in sync (null label).
        update.category_id = null;
        update.niche = null;
      } else {
        // Same validation as the add flow: curated OR this workspace's own
        // custom category; reject foreign/unknown ids.
        const { data: cat } = await sb.raw
          .from("categories")
          .select("id, label, workspace_id")
          .eq("id", rawCategoryId)
          .maybeSingle();
        const allowed = cat && (cat.workspace_id === null || cat.workspace_id === sb.workspaceId);
        if (!allowed) {
          return NextResponse.json(
            { ok: false, error: `Unknown category: ${rawCategoryId}` },
            { status: 400 },
          );
        }
        update.category_id = cat.id as string;
        update.niche = cat.label as string;
      }
    }

    const { data: updated, error } = await sb.raw
      .from("accounts")
      .update(update)
      .eq("id", id)
      .select("id, name, category_id")
      .single();
    if (error || !updated) throw error || new Error("update failed");

    return NextResponse.json({
      ok: true,
      account: {
        id: updated.id as string,
        name: updated.name as string,
        category_id: (updated.category_id as string | null) ?? null,
      },
    });
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

    // This action removes the creator from the current workspace only. Accounts
    // are global catalog rows, so archiving one here would remove it from every
    // other workspace that tracks the same creator.
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

    const { error: untrackErr } = await sb.untrackAccount(id);
    if (untrackErr) throw untrackErr;

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
