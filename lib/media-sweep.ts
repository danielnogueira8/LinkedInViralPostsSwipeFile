import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase";
import type { PostMediaAttachment } from "@/lib/post-media";
import { selectAllRows } from "@/lib/db-paginate";

// ---------------------------------------------------------------------------
// Reference-aware deferred GC for media library assets.
//
// PROBLEM: deleting a library asset used to hard-delete its storage object
// immediately (app/api/media-assets/[id]/route.ts, before this file), with no
// check for whether a draft or scheduled post still referenced it. Draft
// attachments are a SNAPSHOT copied into chat_artifacts.media_attachments at
// attach time, not a live reference — so a deleted-but-still-referenced asset
// silently broke that draft's preview, or (worse) its scheduled publish.
//
// FIX: the DELETE route now only sets media_assets.deleted_at (soft-delete —
// it already stops appearing in reads, same as before). This sweep runs on a
// schedule and only HARD-deletes storage + the row once BOTH:
//   (a) the grace period has elapsed, AND
//   (b) no chat_artifacts.media_attachments row still references it.
// An asset that's still referenced past the grace period is left alone
// (never re-deleted, never un-soft-deleted) — safer to leak a soft-deleted
// row a little longer than to guess wrong and break a live draft.
// ---------------------------------------------------------------------------

export const MEDIA_SWEEP_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export type SweepCandidate = {
  id: string;
  storage_bucket: string;
  storage_path: string;
};

export type SweepResult = {
  candidates: number;
  purged: number;
  stillReferenced: number;
  errors: string[];
};

// Pure: given the sweep's candidate assets and EVERY still-live attachment
// array pulled from chat_artifacts, split candidates into "safe to purge" vs
// "still referenced, leave alone". Exported for unit tests — the DB I/O
// (fetching candidates/attachments, deleting) lives in sweepDeletedMedia.
export function partitionSweepCandidates(
  candidates: SweepCandidate[],
  liveAttachmentArrays: (PostMediaAttachment[] | null | undefined)[],
): { purgeable: SweepCandidate[]; stillReferencedIds: Set<string> } {
  const referencedAssetIds = new Set<string>();
  for (const attachments of liveAttachmentArrays) {
    for (const a of attachments ?? []) {
      if (a.source === "library" && a.assetId) referencedAssetIds.add(a.assetId);
    }
  }
  const purgeable = candidates.filter((c) => !referencedAssetIds.has(c.id));
  const stillReferencedIds = new Set(
    candidates.filter((c) => referencedAssetIds.has(c.id)).map((c) => c.id),
  );
  return { purgeable, stillReferencedIds };
}

// The sweep itself: find soft-deleted assets past the grace period, check
// each against every live draft's media_attachments, and hard-delete
// (storage + row) only the ones nothing references. Never throws — a single
// asset's failure is recorded in `errors` and the sweep continues; the whole
// run is best-effort so a transient storage/DB blip doesn't need a retry
// wrapper of its own (the next scheduled run just tries again).
export async function sweepDeletedMedia(
  now: Date = new Date(),
  sb: SupabaseClient = supabaseAdmin(),
): Promise<SweepResult> {
  const errors: string[] = [];
  const cutoff = new Date(now.getTime() - MEDIA_SWEEP_GRACE_MS).toISOString();

  const { data: candidateRows, error: candidatesErr } = await sb
    .from("media_assets")
    .select("id, storage_bucket, storage_path")
    .not("deleted_at", "is", null)
    .lte("deleted_at", cutoff);
  if (candidatesErr) {
    return { candidates: 0, purged: 0, stillReferenced: 0, errors: [candidatesErr.message] };
  }
  const candidates = (candidateRows ?? []) as SweepCandidate[];
  if (candidates.length === 0) {
    return { candidates: 0, purged: 0, stillReferenced: 0, errors: [] };
  }

  // Every draft's media_attachments could reference ANY asset (drafts aren't
  // scoped by which asset they reference), so this scans all chat_artifacts
  // with a non-empty attachments array. PostgREST silently caps any single
  // read at 1000 rows — past that, this used to look "done" while actually
  // missing rows, so a still-referenced asset past row 1000 would be
  // misclassified as purgeable and hard-deleted. selectAllRows pages through
  // with .range() so every row is seen regardless of table size.
  let draftRows: { media_attachments: PostMediaAttachment[] | null }[];
  try {
    draftRows = await selectAllRows(() =>
      sb
        .from("chat_artifacts")
        .select("media_attachments")
        .not("media_attachments", "is", null) as unknown as {
        range: (
          from: number,
          to: number,
        ) => PromiseLike<{
          data: { media_attachments: PostMediaAttachment[] | null }[] | null;
          error: unknown;
        }>;
      },
    );
  } catch (e) {
    // selectAllRows re-throws PostgREST's raw error value, which is a plain
    // { message, ... } object, not an Error instance — extract .message
    // rather than letting it stringify to "[object Object]".
    const message =
      e instanceof Error
        ? e.message
        : typeof e === "object" && e && "message" in e
          ? String((e as { message: unknown }).message)
          : String(e);
    return { candidates: candidates.length, purged: 0, stillReferenced: 0, errors: [message] };
  }
  const liveAttachmentArrays = draftRows.map((r) => r.media_attachments);

  const { purgeable, stillReferencedIds } = partitionSweepCandidates(
    candidates,
    liveAttachmentArrays,
  );

  let purged = 0;
  for (const asset of purgeable) {
    try {
      const { error: storageErr } = await sb.storage
        .from(asset.storage_bucket)
        .remove([asset.storage_path]);
      if (storageErr) throw storageErr;
      const { error: deleteErr } = await sb.from("media_assets").delete().eq("id", asset.id);
      if (deleteErr) throw deleteErr;
      purged++;
    } catch (e) {
      errors.push(`asset ${asset.id}: ${(e as Error).message}`);
    }
  }

  return {
    candidates: candidates.length,
    purged,
    stillReferenced: stillReferencedIds.size,
    errors,
  };
}
