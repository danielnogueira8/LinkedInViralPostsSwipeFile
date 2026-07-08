import { scopedSupabase } from "@/lib/supabase-scoped";
import type { CustomSkill } from "@/lib/custom-skills";
import { PageHeader, PageShell, Surface } from "@/components/app-surface";
import { SurfaceHelp } from "@/components/surface-help";
import { SurfacePurposeCard } from "@/components/surface-purpose-card";
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
        description={
          <>
            Save reusable instructions Cowork can apply on demand: your CTA style,
            a client&apos;s terminology, or drafting rules you use often. Invoke a
            skill in chat with <code>/name</code> or the skills picker.
          </>
        }
      />
      <SurfacePurposeCard
        title="Skills"
        description="durable rules Cowork should apply when you explicitly select them."
      />
      <Surface tone="flat" padding="sm" className="grid gap-3 sm:grid-cols-3">
        {[
          ["Use a skill when", "You want the same rule applied repeatedly."],
          ["Use a prompt when", "The instruction is only for this one draft."],
          ["Good first skill", "/cta for your standard call-to-action."],
        ].map(([title, body]) => (
          <div key={title} className="rounded-[0.9rem] border border-border/50 bg-card/80 px-3 py-2.5">
            <div className="text-sm font-medium">{title}</div>
            <div className="mt-0.5 text-xs leading-snug text-muted-foreground">
              {body}
            </div>
          </div>
        ))}
      </Surface>
      <SkillsManager initial={(data ?? []) as CustomSkill[]} />
    </PageShell>
  );
}
