import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const sb = await scopedSupabase();
    // `.select()` makes PostgREST return the rows it actually deleted. An empty
    // array means the id didn't match anything in THIS workspace (already gone,
    // or belongs to another tenant) — report 404 instead of a misleading
    // { ok: true } that tells the client a delete happened when it didn't.
    const { data: deleted, error } = await sb.deleteClient(id).select("id");
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    if (!deleted || deleted.length === 0) {
      return NextResponse.json({ ok: false, error: "Brand not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
