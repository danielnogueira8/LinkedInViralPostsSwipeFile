import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";

export const runtime = "nodejs";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = await scopedSupabase();
  const { error } = await sb.deleteClient(id);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
