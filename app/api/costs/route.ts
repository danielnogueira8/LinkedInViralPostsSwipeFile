import { NextResponse } from "next/server";
import { loadCosts } from "@/lib/costs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const data = await loadCosts();
  return NextResponse.json({ ok: true, ...data });
}
