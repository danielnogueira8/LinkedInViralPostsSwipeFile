import { NextResponse } from "next/server";
import { loadCosts } from "@/lib/costs";
import { isAdmin } from "@/lib/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await isAdmin())) {
    return NextResponse.json({ ok: false, error: "Admin only." }, { status: 403 });
  }
  const data = await loadCosts();
  return NextResponse.json({ ok: true, ...data });
}
