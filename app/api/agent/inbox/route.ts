import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { createProductionAgentInbox } from "@/lib/agent-inbox/service";
import { saveAgentInboxPreferences } from "@/lib/agent-inbox/supabase";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";

const preferencesSchema = z.object({
  enabled: z.boolean(),
  timezone: z.string().min(1).max(100),
  deliveryLocalTime: z.string().regex(/^\d{2}:\d{2}$/),
  topics: z.array(z.string().trim().min(1).max(80)).max(10),
  newsSensitivity: z.enum(["low", "standard", "high"]),
});

export async function GET() {
  try {
    const sb = await scopedSupabase();
    const inbox = createProductionAgentInbox(sb.raw);
    const data = await inbox.read(sb.workspaceId, new Date());
    return NextResponse.json({ ok: true, ...data });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const sb = await scopedSupabase();
    const parsed = preferencesSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "Check the Agent settings and try again." },
        { status: 400 },
      );
    }
    await saveAgentInboxPreferences(sb.raw, sb.workspaceId, parsed.data);
    return NextResponse.json({ ok: true, preferences: parsed.data });
  } catch (error) {
    return errorResponse(error);
  }
}
