import { scopedSupabase } from "@/lib/supabase-scoped";
import type { ContentTemplate } from "@/lib/templates";
import { TemplatesManager } from "./manager";

export const dynamic = "force-dynamic";

// Templates — a library of GENERIC, reusable post skeletons (fill-in-the-blank
// structures), NOT derived from scraped posts. The app ships built-in starters;
// the workspace adds its own (the "New template" form now, file upload later).
// "Model in Chat" (added in a follow-up) sends a template into the agent as a
// source to model a new post after. The old post-derived templates lived here
// too; that model is being retired in favor of this generic library (to model a
// real post, users go to the Swipe file / Posts and "Model in Chat" from there).
export default async function TemplatesPage() {
  const sb = await scopedSupabase();
  const { data } = await sb.raw
    .from("content_templates")
    .select(
      "id, workspace_id, title, category, body, source, origin_post_id, created_at, updated_at",
    )
    .eq("workspace_id", sb.workspaceId)
    .order("created_at", { ascending: false });

  const initial = (data ?? []) as ContentTemplate[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-4xl font-display tracking-tight">Templates</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Reusable post structures you can fill in and model in chat. Start from a
          built-in, or add your own.
        </p>
      </div>
      <TemplatesManager initial={initial} />
    </div>
  );
}
