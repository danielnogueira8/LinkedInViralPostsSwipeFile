import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { z } from "zod";

export const runtime = "nodejs";

const clientSchema = z.object({
  name: z.string().min(1),
  brand_colors: z.array(z.object({
    name: z.string().optional(),
    hex: z.string().regex(/^#?[0-9a-fA-F]{6}$/),
  })).default([]),
  notes: z.string().optional().nullable(),
});

export async function GET() {
  const sb = await scopedSupabase();
  const { data, error } = await sb.clientsSelect("*").order("created_at", { ascending: false });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, clients: data });
}

export async function POST(req: Request) {
  const body = await req.json();
  const parsed = clientSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: false, error: parsed.error.message }, { status: 400 });
  const normalized = {
    ...parsed.data,
    brand_colors: parsed.data.brand_colors.map((c) => ({
      ...c,
      hex: c.hex.startsWith("#") ? c.hex : `#${c.hex}`,
    })),
  };
  const sb = await scopedSupabase();
  const { data, error } = await sb.insertClient(normalized).select().single();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, client: data });
}
