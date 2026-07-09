// Overlay the LIVE image state of a weekly-batch draft onto the transcript.
//
// Batch drafts persist twice:
//   • chat_messages.artifacts (jsonb inline blob) — how the drafts panel
//     reads them via GET /api/chats/[id]. Frozen at insert time.
//   • chat_artifacts (row-per-draft) — the source of truth the batch worker
//     and lead-magnet-image job update as work progresses.
//
// The image job runs AFTER the batch settles and writes media_attachments +
// meta.generated_lead_magnet_image ONTO chat_artifacts. The inline blob never
// updates, so a naive /api/chats/[id] reload keeps returning stale batch drafts
// with no image — even after the image landed in the media library.
//
// This helper batches one lookup: for every batch-source artifact in the
// transcript, pull the live row's media_attachments + generated_lead_magnet_image
// and splice them onto the inline blob. Never throws — on any failure the
// transcript keeps its stale (image-less) blob and the UI simply shows the
// pre-image state. Workspace-scoped by caller.

import { supabaseAdmin } from "@/lib/supabase";

// A persisted artifact as it comes back from chat_messages.artifacts. We only
// touch kind + id + meta.source here, so the constraint stays loose.
type StoredArtifact = {
  id?: string;
  kind?: string;
  meta?: { source?: string } | Record<string, unknown> | null;
  media_attachments?: unknown;
  [k: string]: unknown;
};

type MessageWithArtifacts = { artifacts?: unknown };

function asArtifacts(v: unknown): StoredArtifact[] {
  return Array.isArray(v) ? (v as StoredArtifact[]) : [];
}

// A batch draft is an artifact whose meta.source === "weekly_batch". The image
// job only ever runs on batch drafts, so this is the exact set to sync.
// Exported for unit tests.
export function isBatchDraft(a: StoredArtifact): boolean {
  if (a.kind !== "post" && a.kind !== "hook") return false;
  const source = (a.meta as { source?: unknown } | null | undefined)?.source;
  return source === "weekly_batch";
}

// Splice the live chat_artifacts state (media_attachments +
// meta.generated_lead_magnet_image) onto ONE stored artifact. Leaves body,
// title, and every other meta field alone — those live on the inline blob and
// a chat_artifacts edit shouldn't bleed into the transcript out-of-band.
// Pure + exported so the merge logic is unit-testable without a DB.
export function spliceLiveMediaOntoArtifact(
  a: StoredArtifact,
  live: { media_attachments?: unknown; meta: Record<string, unknown> } | undefined,
): StoredArtifact {
  if (!live) return a;
  const nextMeta = {
    ...((a.meta as Record<string, unknown> | null) ?? {}),
    ...(live.meta.generated_lead_magnet_image
      ? { generated_lead_magnet_image: live.meta.generated_lead_magnet_image }
      : {}),
  };
  return {
    ...a,
    meta: nextMeta,
    ...(live.media_attachments
      ? { media_attachments: live.media_attachments }
      : {}),
  };
}

export async function rehydrateBatchArtifactMedia<T extends MessageWithArtifacts>(
  messages: T[],
  workspaceId: string,
): Promise<T[]> {
  try {
    const ids = new Set<string>();
    for (const m of messages) {
      for (const a of asArtifacts(m.artifacts)) {
        if (isBatchDraft(a) && typeof a.id === "string") ids.add(a.id);
      }
    }
    if (ids.size === 0) return messages;
    const { data, error } = await supabaseAdmin()
      .from("chat_artifacts")
      .select("id, media_attachments, meta")
      .eq("workspace_id", workspaceId)
      .in("id", [...ids]);
    if (error || !data) return messages;
    const byId = new Map(
      data.map(
        (row) =>
          [
            row.id as string,
            {
              media_attachments: row.media_attachments as unknown,
              meta: (row.meta ?? {}) as Record<string, unknown>,
            },
          ] as const,
      ),
    );
    return messages.map((m) => {
      const arts = asArtifacts(m.artifacts);
      if (!arts.some(isBatchDraft)) return m;
      return {
        ...m,
        artifacts: arts.map((a) =>
          isBatchDraft(a) && typeof a.id === "string"
            ? spliceLiveMediaOntoArtifact(a, byId.get(a.id))
            : a,
        ),
      };
    });
  } catch {
    return messages;
  }
}
