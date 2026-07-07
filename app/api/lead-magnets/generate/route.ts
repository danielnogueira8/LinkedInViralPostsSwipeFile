import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import {
  leadMagnetGenerateSchema,
} from "@/lib/lead-magnets";
import { generateLeadMagnetResource } from "@/lib/lead-magnet-ai";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const parsed = leadMagnetGenerateSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" },
        { status: 400 },
      );
    }
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ ok: false, error: "Sign in required" }, { status: 401 });
    const sb = await scopedSupabase();

    const created = await generateLeadMagnetResource({
      sb: sb.raw,
      workspaceId: sb.workspaceId,
      userId,
      prompt: parsed.data.prompt,
      ctaUrl: parsed.data.cta_url,
      ctaLabel: parsed.data.cta_label,
    });
    return NextResponse.json({
      ok: true,
      leadMagnet: created.leadMagnet,
      used: created.used,
      limit: created.limit,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
