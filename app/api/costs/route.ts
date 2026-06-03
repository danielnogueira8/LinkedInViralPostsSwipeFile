import { NextResponse } from "next/server";
import { loadCosts } from "@/lib/costs";
import { isAdmin } from "@/lib/admin";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    if (!(await isAdmin())) {
      return NextResponse.json({ ok: false, error: "Admin only." }, { status: 403 });
    }
    const data = await loadCosts();
    return NextResponse.json({ ok: true, ...data });
  } catch (e) {
    return errorResponse(e);
  }
}
