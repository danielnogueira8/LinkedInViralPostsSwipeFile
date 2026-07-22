import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { TrackedCreatorError, TrackedCreators } from "@/lib/tracked-creators";
import { createSupabaseTrackedCreatorsRepository } from "@/lib/tracked-creators-supabase";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";

const bodySchema = z.object({
  account_ids: z.array(z.string().uuid()).min(1).max(200),
  action: z.enum(["track", "untrack"]),
  global_baseline_only: z.boolean().optional().default(false),
});

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
    const creators = new TrackedCreators(
      createSupabaseTrackedCreatorsRepository(sb.raw, sb.workspaceId),
    );
    const affected = await creators.setAccountsTracked({
      accountIds: parsed.data.account_ids,
      tracked: parsed.data.action === "track",
      globalBaselineOnly: parsed.data.global_baseline_only,
    });
    return NextResponse.json({ ok: true, affected });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { ok: false, error: "Invalid JSON body" },
        { status: 400 },
      );
    }
    if (error instanceof TrackedCreatorError) {
      return NextResponse.json(
        { ok: false, error: error.message, code: error.code },
        { status: error.status },
      );
    }
    return errorResponse(error);
  }
}
