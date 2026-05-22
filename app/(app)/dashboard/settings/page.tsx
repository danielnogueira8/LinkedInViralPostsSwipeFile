import { getThresholds, getTemplateThresholds } from "@/lib/viral";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { SettingsForm } from "./form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  // Pass workspaceId so readThresholds picks up this workspace's saved row
  // instead of short-circuiting to env/defaults. Without this the form
  // showed defaults forever — users thought their saves weren't sticking.
  const sb = await scopedSupabase();
  const [viral, template] = await Promise.all([
    getThresholds(sb.workspaceId),
    getTemplateThresholds(sb.workspaceId),
  ]);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-4xl font-display tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Tune what counts as &quot;viral&quot; (swipe file) vs. what gets auto-templated.</p>
      </div>
      <SettingsForm initial={{ viral, template }} />
    </div>
  );
}
