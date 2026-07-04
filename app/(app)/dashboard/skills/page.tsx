import { scopedSupabase } from "@/lib/supabase-scoped";
import type { CustomSkill } from "@/lib/custom-skills";
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
    <div className="space-y-6">
      <div>
        <h1 className="text-4xl font-display tracking-tight">Custom skills</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
          Save reusable instructions the assistant applies on demand — your CTA
          style, a client&apos;s terminology, a post format you always want.
          Invoke a skill in chat by typing <code>/name</code> or picking it from
          the ⚡ menu next to the composer.
        </p>
      </div>
      <div className="grid gap-3 rounded-xl border border-border/60 bg-muted/20 p-3 sm:grid-cols-3">
        {[
          ["Use a skill when", "You want the same rule applied repeatedly."],
          ["Use a prompt when", "The instruction is only for this one draft."],
          ["Good first skill", "/cta for your standard call-to-action."],
        ].map(([title, body]) => (
          <div key={title} className="rounded-lg bg-background px-3 py-2.5">
            <div className="text-sm font-medium">{title}</div>
            <div className="mt-0.5 text-xs leading-snug text-muted-foreground">
              {body}
            </div>
          </div>
        ))}
      </div>
      <SkillsManager initial={(data ?? []) as CustomSkill[]} />
    </div>
  );
}
