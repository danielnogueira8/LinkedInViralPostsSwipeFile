import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/workspace";
import { getCredentialSafe } from "@/lib/leadshark-credentials";
import {
  getLeadSharkAutomationDefaults,
  leadSharkAutomationDefaultsSchema,
  saveLeadSharkAutomationDefaults,
} from "@/lib/leadshark-defaults";
import { validateLeadSharkAutomationDefaults } from "@/lib/leadshark-default-config";
import { scopedSupabase } from "@/lib/supabase-scoped";

export const runtime = "nodejs";

async function defaultsAvailable(
  client: Awaited<ReturnType<typeof scopedSupabase>>["raw"],
): Promise<boolean> {
  const { data, error } = await client
    .from("app_schema_version")
    .select("version")
    .eq("singleton", true)
    .maybeSingle();
  if (error) throw error;
  return (data?.version ?? 0) >= 153;
}

export async function GET() {
  try {
    const sb = await scopedSupabase();
    if (!(await defaultsAvailable(sb.raw))) {
      return NextResponse.json(
        { ok: false, error: "Automation defaults are being prepared." },
        { status: 409 },
      );
    }
    const defaults = await getLeadSharkAutomationDefaults(
      sb.workspaceId,
      sb.raw,
    );
    return NextResponse.json({ ok: true, defaults });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const sb = await scopedSupabase();
    if (!(await defaultsAvailable(sb.raw))) {
      return NextResponse.json(
        { ok: false, error: "Automation defaults are being prepared." },
        { status: 409 },
      );
    }
    const credential = await getCredentialSafe(sb.workspaceId);
    if (!credential.connected) {
      return NextResponse.json(
        { ok: false, error: "Connect LeadShark before saving defaults." },
        { status: 409 },
      );
    }
    const parsed = leadSharkAutomationDefaultsSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          error: parsed.error.issues[0]?.message ?? "Invalid defaults.",
        },
        { status: 400 },
      );
    }
    const issues = validateLeadSharkAutomationDefaults(parsed.data);
    if (issues.length) {
      return NextResponse.json(
        { ok: false, error: issues[0].message, issues },
        { status: 400 },
      );
    }
    await saveLeadSharkAutomationDefaults(
      sb.workspaceId,
      parsed.data,
      sb.raw,
    );
    return NextResponse.json({ ok: true, defaults: parsed.data });
  } catch (error) {
    return errorResponse(error);
  }
}
