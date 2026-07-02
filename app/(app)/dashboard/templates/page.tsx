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
  // Load the workspace's custom templates AND the user's author identity (their
  // voice-profile name + avatar) in parallel. The identity makes each template
  // card read like a real LinkedIn post authored by the user — the pic swaps in
  // automatically once a voice profile exists, and degrades to a neutral "You".
  const [templatesRes, voiceRes] = await Promise.all([
    sb.raw
      .from("content_templates")
      .select(
        "id, workspace_id, title, category, body, source, origin_post_id, created_at, updated_at",
      )
      .eq("workspace_id", sb.workspaceId)
      .order("created_at", { ascending: false }),
    sb.raw
      .from("voice_profiles")
      .select("display_name, avatar_url")
      .eq("workspace_id", sb.workspaceId)
      .maybeSingle(),
  ]);

  const initial = (templatesRes.data ?? []) as ContentTemplate[];
  const author = {
    name: (voiceRes.data?.display_name as string | null) ?? null,
    avatarUrl: (voiceRes.data?.avatar_url as string | null) ?? null,
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-4xl font-display tracking-tight">Templates</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Reusable post structures you can fill in and model in chat. Start from a
          built-in, or add your own.
        </p>
      </div>
      <TemplatesManager initial={initial} author={author} />
    </div>
  );
}
