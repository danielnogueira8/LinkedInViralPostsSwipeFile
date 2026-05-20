import { getThresholds, getTemplateThresholds } from "@/lib/viral";
import { SettingsForm } from "./form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [viral, template] = await Promise.all([getThresholds(), getTemplateThresholds()]);
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
