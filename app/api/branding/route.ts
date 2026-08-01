import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import {
  brandInputSchema,
  createBrandResource,
} from "@/lib/content-resource-operations";

export const runtime = "nodejs";

export async function GET() {
  try {
    const sb = await scopedSupabase();
    const { data, error } = await sb.clientsSelect("*").order("created_at", { ascending: false });
    if (error) return errorResponse(error);
    return NextResponse.json({ ok: true, clients: data });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const parsed = brandInputSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ ok: false, error: parsed.error.message }, { status: 400 });
    const sb = await scopedSupabase();
    const result = await createBrandResource({
      db: sb.raw,
      workspaceId: sb.workspaceId,
      data: parsed.data,
    });
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    }
    return NextResponse.json({ ok: true, client: result.value });
  } catch (e) {
    return errorResponse(e);
  }
}
