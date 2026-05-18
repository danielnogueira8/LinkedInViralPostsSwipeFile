import { NextResponse } from "next/server";
import { syncAccountsFromSheet } from "@/lib/sheets";

export const runtime = "nodejs";

export async function POST() {
  try {
    const { count, skipped, at } = await syncAccountsFromSheet();
    return NextResponse.json({ ok: true, count, skipped, at });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
