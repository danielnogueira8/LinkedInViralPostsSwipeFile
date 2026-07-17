import { describe, test, expect, vi } from "vitest";
import { partitionSweepCandidates, sweepDeletedMedia, MEDIA_SWEEP_GRACE_MS } from "@/lib/media-sweep";
import type { PostMediaAttachment } from "@/lib/post-media";

// ---------------------------------------------------------------------------
// Media asset deferred GC. Deleting a library asset used to hard-delete
// storage immediately, with zero check for whether a draft/scheduled post
// still referenced it (attachments are a SNAPSHOT copied at attach time, not
// a live reference). The DELETE route now only soft-deletes; this sweep is
// the actual garbage collector — it must NEVER purge an asset something
// still references, however long it's been soft-deleted.
// ---------------------------------------------------------------------------

function attachment(assetId: string): PostMediaAttachment {
  return {
    id: "att-1",
    source: "library",
    assetId,
    name: "photo.jpg",
    mimeType: "image/jpeg",
    size: 1024,
    type: "image",
    uploadedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("partitionSweepCandidates — pure reference check", () => {
  test("an asset with no reference anywhere is purgeable", () => {
    const { purgeable, stillReferencedIds } = partitionSweepCandidates(
      [{ id: "a1", storage_bucket: "b", storage_path: "p" }],
      [[], null, undefined],
    );
    expect(purgeable.map((c) => c.id)).toEqual(["a1"]);
    expect(stillReferencedIds.size).toBe(0);
  });

  test("an asset referenced by ANY live draft is NOT purgeable", () => {
    const { purgeable, stillReferencedIds } = partitionSweepCandidates(
      [{ id: "a1", storage_bucket: "b", storage_path: "p" }],
      [[attachment("a1")]],
    );
    expect(purgeable).toHaveLength(0);
    expect(stillReferencedIds.has("a1")).toBe(true);
  });

  test("only zernio-sourced attachments (no assetId) never block a purge", () => {
    const zernioAttachment: PostMediaAttachment = {
      id: "att-2",
      source: "zernio",
      name: "photo.jpg",
      mimeType: "image/jpeg",
      size: 1024,
      type: "image",
      uploadedAt: "2026-01-01T00:00:00.000Z",
    };
    const { purgeable } = partitionSweepCandidates(
      [{ id: "a1", storage_bucket: "b", storage_path: "p" }],
      [[zernioAttachment]],
    );
    expect(purgeable.map((c) => c.id)).toEqual(["a1"]);
  });

  test("mixed batch: only the unreferenced ones are purgeable", () => {
    const { purgeable, stillReferencedIds } = partitionSweepCandidates(
      [
        { id: "a1", storage_bucket: "b", storage_path: "p1" },
        { id: "a2", storage_bucket: "b", storage_path: "p2" },
        { id: "a3", storage_bucket: "b", storage_path: "p3" },
      ],
      [[attachment("a2")]],
    );
    expect(purgeable.map((c) => c.id).sort()).toEqual(["a1", "a3"]);
    expect(stillReferencedIds.has("a2")).toBe(true);
  });
});

describe("sweepDeletedMedia — orchestration", () => {
  function fakeClient(opts: {
    candidates: Array<{ id: string; storage_bucket: string; storage_path: string }>;
    drafts: Array<{ media_attachments: PostMediaAttachment[] | null }>;
    candidatesError?: { message: string };
    draftsError?: { message: string };
    storageError?: { message: string };
    deleteError?: { message: string };
  }) {
    const removeSpy = vi.fn(async () => ({ error: opts.storageError ?? null }));
    const deletedIds: string[] = [];
    return {
      removeSpy,
      deletedIds,
      client: {
        from(table: string) {
          if (table === "media_assets") {
            return {
              select: () => ({
                not: () => ({
                  lte: async () => ({
                    data: opts.candidatesError ? null : opts.candidates,
                    error: opts.candidatesError ?? null,
                  }),
                }),
              }),
              delete: () => ({
                eq: async (_col: string, id: string) => {
                  deletedIds.push(id);
                  return { error: opts.deleteError ?? null };
                },
              }),
            };
          }
          if (table === "chat_artifacts") {
            return {
              select: () => ({
                not: () => ({
                  // selectAllRows pages via .range(from, to); return this
                  // page's slice and let the caller stop once a page comes
                  // back short of DB_PAGE (1000) rows.
                  range: async (from: number, to: number) => {
                    if (opts.draftsError) return { data: null, error: opts.draftsError };
                    return { data: opts.drafts.slice(from, to + 1), error: null };
                  },
                }),
              }),
            };
          }
          throw new Error(`unexpected table ${table}`);
        },
        storage: { from: () => ({ remove: removeSpy }) },
      },
    };
  }

  test("purges an unreferenced, past-grace asset (storage + row)", async () => {
    const { client, removeSpy, deletedIds } = fakeClient({
      candidates: [{ id: "a1", storage_bucket: "media-assets", storage_path: "ws/a1.png" }],
      drafts: [],
    });
    const result = await sweepDeletedMedia(new Date("2026-02-01T00:00:00.000Z"), client as never);
    expect(result).toEqual({ candidates: 1, purged: 1, stillReferenced: 0, errors: [] });
    expect(removeSpy).toHaveBeenCalledWith(["ws/a1.png"]);
    expect(deletedIds).toEqual(["a1"]);
  });

  test("does NOT purge an asset still referenced by a live draft", async () => {
    const { client, removeSpy, deletedIds } = fakeClient({
      candidates: [{ id: "a1", storage_bucket: "media-assets", storage_path: "ws/a1.png" }],
      drafts: [{ media_attachments: [attachment("a1")] }],
    });
    const result = await sweepDeletedMedia(new Date("2026-02-01T00:00:00.000Z"), client as never);
    expect(result).toEqual({ candidates: 1, purged: 0, stillReferenced: 1, errors: [] });
    expect(removeSpy).not.toHaveBeenCalled();
    expect(deletedIds).toEqual([]);
  });

  test("no candidates → clean no-op, never touches chat_artifacts", async () => {
    const { client } = fakeClient({ candidates: [], drafts: [] });
    const fromSpy = vi.spyOn(client, "from");
    const result = await sweepDeletedMedia(new Date(), client as never);
    expect(result).toEqual({ candidates: 0, purged: 0, stillReferenced: 0, errors: [] });
    expect(fromSpy).toHaveBeenCalledTimes(1); // only the media_assets candidate query
  });

  test("a storage removal failure is recorded per-asset, doesn't abort the batch", async () => {
    const { client, deletedIds } = fakeClient({
      candidates: [
        { id: "a1", storage_bucket: "b", storage_path: "p1" },
        { id: "a2", storage_bucket: "b", storage_path: "p2" },
      ],
      drafts: [],
      storageError: { message: "storage unavailable" },
    });
    const result = await sweepDeletedMedia(new Date(), client as never);
    expect(result.purged).toBe(0);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain("storage unavailable");
    expect(deletedIds).toEqual([]); // never deletes the row if storage removal failed
  });

  test("a candidates-query failure returns a clean error result, not a throw", async () => {
    const { client } = fakeClient({
      candidates: [],
      drafts: [],
      candidatesError: { message: "db down" },
    });
    const result = await sweepDeletedMedia(new Date(), client as never);
    expect(result).toEqual({ candidates: 0, purged: 0, stillReferenced: 0, errors: ["db down"] });
  });

  test("grace period is 7 days", () => {
    expect(MEDIA_SWEEP_GRACE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test("a reference past the 1000-row PostgREST page cap is still seen (pagination, not truncation)", async () => {
    // The bug this guards: the old single-shot select() silently capped at
    // 1000 rows, so a draft sorting past row 1000 was invisible — its
    // referenced asset would be misclassified purgeable and hard-deleted.
    // Build 1001 drafts with the referencing one LAST, past the first page.
    const drafts: Array<{ media_attachments: PostMediaAttachment[] | null }> = Array.from(
      { length: 1000 },
      () => ({ media_attachments: null }),
    );
    drafts.push({ media_attachments: [attachment("a1")] });
    const { client, removeSpy, deletedIds } = fakeClient({
      candidates: [{ id: "a1", storage_bucket: "media-assets", storage_path: "ws/a1.png" }],
      drafts,
    });
    const result = await sweepDeletedMedia(new Date("2026-02-01T00:00:00.000Z"), client as never);
    expect(result).toEqual({ candidates: 1, purged: 0, stillReferenced: 1, errors: [] });
    expect(removeSpy).not.toHaveBeenCalled();
    expect(deletedIds).toEqual([]);
  });

  test("a drafts-query failure on a later page returns a clean error result, not a throw", async () => {
    const { client } = fakeClient({
      candidates: [{ id: "a1", storage_bucket: "b", storage_path: "p" }],
      drafts: [],
      draftsError: { message: "db down mid-scan" },
    });
    const result = await sweepDeletedMedia(new Date(), client as never);
    expect(result).toEqual({ candidates: 1, purged: 0, stillReferenced: 0, errors: ["db down mid-scan"] });
  });
});
