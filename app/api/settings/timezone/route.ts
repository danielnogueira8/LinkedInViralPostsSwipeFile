import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// The workspace's default IANA timezone. Used by the schedule_publish agent
// tool as a FALLBACK when the user says "schedule this for tomorrow noon"
// without specifying a timezone — so they don't have to say "Europe/Lisbon"
// every time. Separate from the viral-thresholds POST so we don't couple the
// timezone change to the is_viral bulk re-evaluation.
// -----------------------------------------------------------------------------

// Validate that a string is a real IANA timezone id. Intl.DateTimeFormat throws
// (or, on older engines, silently accepts) an unknown zone — construct one to
// probe. An empty string clears the setting.
function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const bodySchema = z.object({
  timezone: z
    .string()
    .trim()
    .max(100)
    .nullable()
    // Null → clear the default.
    .refine((v) => v === null || v === "" || isValidTimeZone(v), {
      message: "Not a valid IANA timezone (e.g. Europe/Lisbon, America/New_York).",
    }),
});

export async function GET() {
  try {
    const sb = await scopedSupabase();
    const { data } = await sb.settings().eq("key", "default_timezone").maybeSingle();
    const raw = (data as { value?: unknown } | null)?.value ?? null;
    // Support both string values and { timezone: "..." } shapes (defensive).
    let timezone: string | null = null;
    if (typeof raw === "string") timezone = raw;
    else if (raw && typeof raw === "object" && typeof (raw as { timezone?: unknown }).timezone === "string") {
      timezone = (raw as { timezone: string }).timezone;
    }
    return NextResponse.json({ ok: true, timezone });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid timezone." },
        { status: 400 },
      );
    }
    const sb = await scopedSupabase();
    const value = parsed.data.timezone && parsed.data.timezone.length > 0 ? parsed.data.timezone : null;
    const { error } = await sb.upsertSetting("default_timezone", value);
    if (error) throw error;
    return NextResponse.json({ ok: true, timezone: value });
  } catch (e) {
    return errorResponse(e);
  }
}
