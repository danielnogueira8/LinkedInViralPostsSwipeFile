import { Suspense } from "react";
import { getThresholds, getTemplateThresholds } from "@/lib/viral";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { SettingsForm } from "./form";
import { PublishingCard } from "./publishing-card";
import { DangerZone } from "./danger-zone";
import { PageHeader, PageShell } from "@/components/app-surface";
import { getDiscoveryThresholds } from "@/lib/discovery-thresholds";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  // Pass workspaceId so readThresholds picks up this workspace's saved row
  // instead of short-circuiting to env/defaults. Without this the form
  // showed defaults forever — users thought their saves weren't sticking.
  const sb = await scopedSupabase();
  const [viral, template, discovery] = await Promise.all([
    getThresholds(sb.workspaceId),
    getTemplateThresholds(sb.workspaceId),
    getDiscoveryThresholds(sb.workspaceId, sb.raw),
  ]);
  return (
    <PageShell>
      <PageHeader
        title="Settings"
        description="Tune discovery thresholds, publishing, and workspace-level account controls."
      />
      <SettingsForm initial={{ viral, template, discovery }} />

      {/* Suspense: PublishingCard reads useSearchParams (?linkedin= callback). */}
      <Suspense fallback={null}>
        <PublishingCard />
      </Suspense>

      <div className="pt-2">
        <DangerZone />
      </div>
    </PageShell>
  );
}
