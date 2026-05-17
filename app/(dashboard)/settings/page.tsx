import { getThresholds } from "@/lib/viral";
import { SettingsForm } from "./form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const t = await getThresholds();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Tune what counts as &quot;viral&quot;.</p>
      </div>
      <SettingsForm initial={t} />
    </div>
  );
}
