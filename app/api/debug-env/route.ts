import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    has_anthropic: !!process.env.ANTHROPIC_API_KEY,
    anthropic_len: (process.env.ANTHROPIC_API_KEY || "").length,
    has_swipe_anthropic: !!process.env.SWIPE_ANTHROPIC_KEY,
    swipe_anthropic_len: (process.env.SWIPE_ANTHROPIC_KEY || "").length,
    has_supabase_url: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
    has_supabase_secret: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    has_apify: !!process.env.APIFY_API_TOKEN,
    node_env: process.env.NODE_ENV,
  });
}
