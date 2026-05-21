import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { z } from "zod";

export const runtime = "nodejs";

const bodySchema = z.object({
  account_id: z.string().uuid(),
  action: z.enum(["track", "untrack"]),
});

export async function POST(req: Request) {
  try {
    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: parsed.error.message }, { status: 400 });
    }
    const { account_id, action } = parsed.data;
    const sb = await scopedSupabase();

    if (action === "track") {
      const { error } = await sb.trackAccount(account_id);
      if (error) throw error;
    } else {
      const { error } = await sb.untrackAccount(account_id);
      if (error) throw error;
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
