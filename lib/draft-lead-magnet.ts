import type { SupabaseClient } from "@supabase/supabase-js";

export type DraftLeadMagnetContext = {
  title: string;
  selection: "manual" | "auto";
  // Present when the stamp came from a lead_magnets row (the giveaway picker's
  // value). Older/agent-stamped metas may carry only the title.
  id?: string;
};

export function leadMagnetContextFromMeta(meta: unknown): DraftLeadMagnetContext | null {
  if (!meta || typeof meta !== "object") return null;
  const leadMagnet = (meta as { lead_magnet?: unknown }).lead_magnet;
  if (!leadMagnet || typeof leadMagnet !== "object") return null;
  const raw = leadMagnet as Record<string, unknown>;
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) return null;
  const id = typeof raw.id === "string" && raw.id ? raw.id : undefined;
  return {
    title,
    selection: raw.selection === "manual" ? "manual" : "auto",
    ...(id ? { id } : {}),
  };
}

// The meta.lead_magnet stamp written when a giveaway is attached to a draft.
export type LeadMagnetStamp = {
  id: string;
  title: string;
  selection: "manual";
  public_slug: string | null;
};

// Resolve a picker-chosen lead-magnet id into the meta.lead_magnet stamp the
// board's "Giveaway" row and the comment-to-DM automation read. Workspace-scoped
// so a client can't attach another workspace's magnet. Returns null when the id
// doesn't resolve. Shared by POST /api/drafts (create) and PATCH /api/drafts/[id]
// (attach/change the giveaway on an existing lead-magnet post).
export async function resolveLeadMagnetStamp(
  db: SupabaseClient,
  workspaceId: string,
  leadMagnetId: string,
): Promise<LeadMagnetStamp | null> {
  const { data, error } = await db
    .from("lead_magnets")
    .select("id, title, public_slug")
    .eq("id", leadMagnetId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    id: data.id,
    title: data.title,
    selection: "manual",
    public_slug: (data.public_slug as string | null) ?? null,
  };
}
