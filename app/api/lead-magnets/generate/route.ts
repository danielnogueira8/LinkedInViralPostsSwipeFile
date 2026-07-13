import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import {
  leadMagnetGenerateSchema,
} from "@/lib/lead-magnets";
import {
  generateLeadMagnetResource,
  LeadMagnetCostCapError,
} from "@/lib/lead-magnet-ai";
import { checkChatCostAllowance } from "@/lib/agent/rate-limit";

export const runtime = "nodejs";

const LEAD_MAGNET_GENERATION_COST_RESERVE_USD = 0.05;

// Rough cost of one lead-magnet generation (a GLM-5.2 completion for the
// resource body). Kept conservative so the pre-check errs toward blocking
// slightly early when the workspace is near the monthly cap.
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
    if (e instanceof LeadMagnetCostCapError) {
      return NextResponse.json(
        { ok: false, reason: "monthly", error: e.message },
        { status: 429 },
      );
    }
    return errorResponse(e);
  }
}
