import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { displayNameFromHandle, fetchProfileMeta } from "@/lib/linkedin-url";
import { TrackedCreatorError, TrackedCreators } from "@/lib/tracked-creators";
import { createSupabaseTrackedCreatorsRepository } from "@/lib/tracked-creators-supabase";

export const runtime = "nodejs";

type Body = {
  profile_url?: string;
  name?: string;
  category_id?: string | null;
};

async function creators() {
  const sb = await scopedSupabase();
  const repository = createSupabaseTrackedCreatorsRepository(
    sb.raw,
    sb.workspaceId,
    {
      isTracked: async (accountId) => {
        const { data, error } = await sb
          .workspaceAccountsSelect("account_id")
          .eq("account_id", accountId)
          .maybeSingle();
        if (error) throw error;
        return Boolean(data);
      },
      track: async (accountId, niche) => {
        const { error } = await sb.trackAccount(accountId, niche);
        if (error) throw error;
      },
      untrack: async (accountId) => {
        const { error } = await sb.untrackAccount(accountId);
        if (error) throw error;
        return true;
      },
    },
  );
  return new TrackedCreators(repository, {
    fetchProfileMeta,
    displayNameFromHandle,
  });
}

function failure(error: unknown) {
  if (error instanceof TrackedCreatorError) {
    return NextResponse.json(
      { ok: false, error: error.message, code: error.code },
      { status: error.status },
    );
  }
  return NextResponse.json(
    { ok: false, error: (error as Error)?.message ?? "Unexpected error" },
    { status: 500 },
  );
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const result = await (
      await creators()
    ).add({
      profileUrl: body.profile_url ?? "",
      name: body.name,
      categoryId: body.category_id,
      duplicate: "reject",
    });
    return NextResponse.json({
      ok: true,
      account: {
        id: result.account.id,
        name: result.account.name,
        source: result.account.source,
      },
      meta_resolved: result.metaResolved,
    });
  } catch (error) {
    return failure(error);
  }
}

type PatchBody = {
  id?: string;
  name?: string;
  category_id?: string | null;
};

export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as PatchBody;
    const id = body.id?.trim() ?? "";
    if (!id) {
      return NextResponse.json(
        { ok: false, error: "id required" },
        { status: 400 },
      );
    }
    const input: { id: string; name?: string; categoryId?: string | null } = {
      id,
    };
    if (typeof body.name === "string") input.name = body.name;
    if ("category_id" in body) input.categoryId = body.category_id;
    const account = await (await creators()).updateManual(input);
    return NextResponse.json({
      ok: true,
      account: {
        id: account.id,
        name: account.name,
        category_id: account.categoryId,
      },
    });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(req: Request) {
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) {
      return NextResponse.json(
        { ok: false, error: "id required" },
        { status: 400 },
      );
    }
    await (await creators()).remove({ id }, true);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}
