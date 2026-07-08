import { scopedSupabase } from "@/lib/supabase-scoped";
import type { CreatorStyleRow } from "@/lib/creator-styles";
import { PageHeader, PageShell, Surface } from "@/components/app-surface";
import { SurfaceHelp } from "@/components/surface-help";
import { SurfacePurposeCard } from "@/components/surface-purpose-card";
import { CreatorStylesManager, type PickerCreator } from "./manager";

export const dynamic = "force-dynamic";

const COLS =
  "id, workspace_id, name, creator_name, creator_handle, creator_avatar_url, source_account_id, description, sample_count, status, error, profile_json, prompt_block, generated_at, generating_started_at, created_at, updated_at";

// Creator Styles — a library of reusable WRITING-STYLE profiles distilled from
// creators the workspace tracks. Each captures the creator's writing MECHANICS
// (hooks, cadence, formatting, structure, rhythm, CTA habits) so the user can
// write ORIGINAL posts in that style in Cowork — never copying their topics,
// stories, claims, or wording. Sibling of Templates: workspace-owned, generated
// (async), and selectable in Cowork (PR 3).
export default async function CreatorStylesPage() {
  const sb = await scopedSupabase();

  // The workspace's styles + the tracked creators (for the create flow's picker),
  // in parallel. Creators = the accounts this workspace tracks, joined to their
  // display metadata; a style can only be built from a tracked creator.
  const [stylesRes, trackedRes] = await Promise.all([
    sb.raw
      .from("creator_style_profiles")
      .select(COLS)
      .eq("workspace_id", sb.workspaceId)
      .order("created_at", { ascending: false }),
    sb.workspaceAccountsSelect("account_id"),
  ]);

  const initial = (stylesRes.data ?? []) as CreatorStyleRow[];

  const trackedIds = (
    (trackedRes.data ?? []) as unknown as Array<{ account_id: string }>
  ).map((r) => r.account_id);

  let creators: PickerCreator[] = [];
  if (trackedIds.length) {
    const { data: accountRows } = await sb.raw
      .from("accounts")
      .select("id, name, linkedin_handle, profile_pic_url")
      .in("id", trackedIds)
      .is("archived_at", null)
      .order("name");
    creators = ((accountRows ?? []) as Array<Record<string, unknown>>).map((a) => ({
      id: a.id as string,
      name: (a.name as string) ?? "",
      handle: (a.linkedin_handle as string | null) ?? null,
      avatarUrl: (a.profile_pic_url as string | null) ?? null,
    }));
  }

  return (
    <PageShell>
      <PageHeader
        title="Creator Styles"
        meta={
          <SurfaceHelp title="Writing mechanics learned from tracked creators. Use them to borrow rhythm, formatting, and structure without copying content." />
        }
        description="Reusable writing-style profiles from creators you track. Apply one in Cowork when you want an original post with similar pacing, hooks, formatting, or CTA habits."
      />
      <SurfacePurposeCard
        title="Creator Styles"
        description="borrow another creator's writing mechanics while keeping the topic and claims yours."
      />
      <Surface tone="flat" padding="sm" className="grid gap-3 sm:grid-cols-3">
        {[
          ["Use Creator Styles when", "You like how someone writes, not what they wrote."],
          ["Use Templates when", "You want a fixed post structure or fill-in skeleton."],
          ["Keep original", "Cowork should use your topic, claims, and examples."],
        ].map(([title, body]) => (
          <div key={title} className="rounded-[0.9rem] border border-border/50 bg-card/80 px-3 py-2.5">
            <div className="text-sm font-medium">{title}</div>
            <div className="mt-0.5 text-xs leading-snug text-muted-foreground">{body}</div>
          </div>
        ))}
      </Surface>
      <CreatorStylesManager initial={initial} creators={creators} />
    </PageShell>
  );
}
