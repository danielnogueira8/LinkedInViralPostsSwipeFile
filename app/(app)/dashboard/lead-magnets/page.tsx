import { auth } from "@clerk/nextjs/server";
import { PageHeader, PageShell } from "@/components/app-surface";
import { scopedSupabase } from "@/lib/supabase-scoped";
import {
  LEAD_MAGNET_AI_MONTHLY_LIMIT,
  LEAD_MAGNET_COLS,
  coerceLeadMagnet,
  monthStartIso,
  type LeadMagnet,
} from "@/lib/lead-magnets";
import { LeadMagnetsManager } from "./manager";

export const dynamic = "force-dynamic";

export default async function LeadMagnetsPage() {
  const sb = await scopedSupabase();
  const { userId } = await auth();
  const [leadMagnetsRes, countRes, voiceRes] = await Promise.all([
    sb.raw
      .from("lead_magnets")
      .select(LEAD_MAGNET_COLS)
      .eq("workspace_id", sb.workspaceId)
      .order("updated_at", { ascending: false }),
    userId
      ? sb.raw
          .from("lead_magnets")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("source_type", "ai")
          .gte("created_at", monthStartIso())
      : Promise.resolve({ count: 0, error: null }),
    sb.raw
      .from("voice_profiles")
      .select("profile_url")
      .eq("workspace_id", sb.workspaceId)
      .maybeSingle(),
  ]);
  if (leadMagnetsRes.error) throw leadMagnetsRes.error;
  if (countRes.error) throw countRes.error;
  if (voiceRes.error) throw voiceRes.error;

  return (
    <PageShell>
      <PageHeader
        title="Lead Magnets"
        description="Create markdown resources, import public docs, and share read-only links people can view without signing in."
      />
      <LeadMagnetsManager
        initial={((leadMagnetsRes.data ?? []) as LeadMagnet[]).map(coerceLeadMagnet)}
        aiUsed={countRes.count ?? 0}
        aiLimit={LEAD_MAGNET_AI_MONTHLY_LIMIT}
        defaultCtaUrl={(voiceRes.data?.profile_url as string | null) ?? null}
      />
    </PageShell>
  );
}
