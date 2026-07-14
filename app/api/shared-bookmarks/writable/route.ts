import { NextResponse } from "next/server";
import { listWritableLibraries } from "@/lib/shared-bookmarks";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";

export async function GET() {
  try {
    const libraries = await listWritableLibraries();
    return NextResponse.json({ ok: true, libraries });
  } catch (error) {
    return errorResponse(error);
  }
}
