import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { TrackedCreatorError, TrackedCreators } from "@/lib/tracked-creators";
import { createSupabaseTrackedCreatorsRepository } from "@/lib/tracked-creators-supabase";

export const runtime = "nodejs";

const bodySchema = z.object({
  account_id: z.string().uuid(),
  action: z.enum(["track", "untrack"]),
});

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
    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.message },
        { status: 400 },
      );
    }

    const sb = await scopedSupabase();
    const repository = createSupabaseTrackedCreatorsRepository(
      sb.raw,
      sb.workspaceId,
      {
        track: async (accountId) => {
          const { error } = await sb.trackAccount(accountId);
          if (error) throw error;
        },
        untrack: async (accountId) => {
          const { error } = await sb.untrackAccount(accountId);
          if (error) throw error;
          return true;
        },
      },
    );
    const creators = new TrackedCreators(repository);
    if (parsed.data.action === "track") {
      await creators.trackExisting(parsed.data.account_id);
    } else {
      await creators.untrack(parsed.data.account_id);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { ok: false, error: "Invalid JSON body" },
        { status: 400 },
      );
    }
    return failure(error);
  }
}
