import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import {
  leadMagnetGenerateSchema,
} from "@/lib/lead-magnets";
import { generateLeadMagnetResource } from "@/lib/lead-magnet-ai";
import { checkChatCostAllowance } from "@/lib/agent/rate-limit";

export const runtime = "nodejs";

// Required headroom before starting a lead-magnet generation. Standardized
// at $1 to match the other non-chat paths (VOICE / BATCH / VISION reserves
// in lib/agent/rate-limit.ts) — a lead-magnet turn spends only ~$0.05 in
// practice, but the reserve represents the WORST PLAUSIBLE cost with margin,
// so we don't kick off a job unless the workspace has real budget headroom.
const LEAD_MAGNET_GENERATION_COST_RESERVE_USD = 1.0;

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

    // Monthly cost cap — every LLM path must respect the plan's spend ceiling,
    // not just chat. Before this check, a workspace already over the monthly
    // budget could still generate lead-magnets (an ~$0.05 GLM turn) at no
    // rate limit, only the internal LEAD_MAGNET_AI_MONTHLY_LIMIT counter.
    const rl = await checkChatCostAllowance(
      sb.workspaceId,
      LEAD_MAGNET_GENERATION_COST_RESERVE_USD,
    );
    if (!rl.ok) {
      return NextResponse.json(
        { ok: false, error: rl.message, reason: rl.reason },
        {
          status: 429,
          headers: rl.retryAfterSec ? { "Retry-After": String(rl.retryAfterSec) } : undefined,
        },
      );
    }

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
