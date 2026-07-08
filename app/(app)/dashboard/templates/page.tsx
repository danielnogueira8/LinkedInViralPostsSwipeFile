import { scopedSupabase } from "@/lib/supabase-scoped";
import type { ContentTemplate } from "@/lib/templates";
import { TemplatesManager } from "./manager";
import { PageHeader, PageShell, Surface } from "@/components/app-surface";
import { SurfaceHelp } from "@/components/surface-help";
import { SurfacePurposeCard } from "@/components/surface-purpose-card";

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
    <PageShell>
      <PageHeader
        title="Templates"
        meta={
          <SurfaceHelp title="Reusable post structures. Use templates when you want Cowork to follow a specific skeleton, not another creator's writing style." />
        }
        description="Reusable post structures you can fill in or model in Cowork. They define the shape of a post, not the topic or voice."
      />
      <SurfacePurposeCard
        title="Templates"
        description="reusable structures for posts where you already know the shape you want."
      />
      <Surface tone="flat" padding="sm" className="grid gap-3 sm:grid-cols-3">
        {[
          ["Use templates when", "You want the same post skeleton reused."],
          ["Use Creator Styles when", "You want another creator's rhythm or formatting."],
          ["Use Cowork directly when", "You only need one post from a plain prompt."],
        ].map(([title, body]) => (
          <div key={title} className="rounded-[0.9rem] border border-border/50 bg-card/80 px-3 py-2.5">
            <div className="text-sm font-medium">{title}</div>
            <div className="mt-0.5 text-xs leading-snug text-muted-foreground">{body}</div>
          </div>
        ))}
      </Surface>
      <TemplatesManager initial={initial} author={author} />
    </PageShell>
  );
}
