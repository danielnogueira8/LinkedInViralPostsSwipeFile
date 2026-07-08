import { scopedSupabase } from "@/lib/supabase-scoped";
import type { CustomSkill } from "@/lib/custom-skills";
import { PageHeader, PageShell } from "@/components/app-surface";
import { SurfaceHelp } from "@/components/surface-help";
import { SkillsManager } from "./manager";

export const dynamic = "force-dynamic";

// Custom skills management. A skill is a named block of guidance the agent
// injects into a turn — authored here, invoked in chat via /name or the ⚡
// picker. Workspace-shared.
export default async function SkillsPage() {
  const sb = await scopedSupabase();
  const { data } = await sb.raw
    .from("custom_skills")
    .select("id, workspace_id, name, description, body, created_at, updated_at")
    .eq("workspace_id", sb.workspaceId)
    .order("created_at", { ascending: false });

  return (
    <PageShell>
      <PageHeader
        title="Custom skills"
        meta={
          <SurfaceHelp title="Durable instructions and examples for Cowork. Use skills when you want a repeatable rule for future drafts." />
        }
        description="Reusable instructions Cowork can apply on demand."
      />
      <SkillsManager initial={(data ?? []) as CustomSkill[]} />
    </PageShell>
  );
}
