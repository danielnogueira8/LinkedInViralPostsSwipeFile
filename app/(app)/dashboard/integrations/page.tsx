import { Suspense } from "react";
import { PageHeader, PageShell } from "@/components/app-surface";
import { SurfaceHelp } from "@/components/surface-help";
import { getWorkspaceId } from "@/lib/workspace";
import {
  getCredentialSafe,
  type LeadSharkCredentialSafe,
} from "@/lib/leadshark-credentials";
import { LeadSharkCard } from "./leadshark-card";
import { LinkedInPublishingCard } from "./linkedin-card";
import { getLeadSharkAutomationDefaults } from "@/lib/leadshark-defaults";
import { defaultLeadSharkAutomationDefaults } from "@/lib/leadshark-default-config";
import { scopedSupabase } from "@/lib/supabase-scoped";

export const dynamic = "force-dynamic";

// Integrations hub. Home for third-party tools the user connects to SwipeIn:
// LinkedIn publishing through Zernio and LeadShark comment-triggered auto-DMs.
export default async function IntegrationsPage() {
  const workspaceId = await getWorkspaceId();
  const sb = workspaceId ? await scopedSupabase() : null;

  // Signed-out safety: render the not-connected shape rather than throwing.
  const initial: LeadSharkCredentialSafe = workspaceId
    ? await getCredentialSafe(workspaceId)
    : {
        connected: false,
        status: "revoked",
        keyHint: null,
        lastVerifiedAt: null,
        lastError: null,
      };
  const { data: marker } = sb
    ? await sb.raw
        .from("app_schema_version")
        .select("version")
        .eq("singleton", true)
        .maybeSingle()
    : { data: null };
  const defaultsAvailable = (marker?.version ?? 0) >= 153;
  const initialDefaults =
    workspaceId && sb && defaultsAvailable
      ? await getLeadSharkAutomationDefaults(workspaceId, sb.raw)
      : defaultLeadSharkAutomationDefaults();

  return (
    <PageShell width="wide">
      <PageHeader
        title="Integrations"
        meta={
          <SurfaceHelp title="Connect LinkedIn for publishing and analytics, and connect LeadShark to auto-DM people who comment on your lead-magnet posts." />
        }
        description="Connect the accounts and tools SwipeIn uses for publishing, analytics, and automations."
      />

      <div className="space-y-4">
        <Suspense fallback={null}>
          <LinkedInPublishingCard returnTo="integrations" />
        </Suspense>

        <LeadSharkCard
          initial={initial}
          initialDefaults={initialDefaults}
          defaultsAvailable={defaultsAvailable}
        />
      </div>
    </PageShell>
  );
}
