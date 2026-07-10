import { describe, test, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PostMediaAttachment } from "@/lib/post-media";

// ---------------------------------------------------------------------------
// Publish-time library-asset resolution (ensureZernioMediaAttachments in
// lib/media-library.ts). The load-bearing behavior pinned here:
//
//   A SOFT-DELETED library asset still resolves for publishing. Deleting an
//   asset from the library only sets media_assets.deleted_at; the media sweep
//   (lib/media-sweep.ts) deliberately preserves storage bytes for any asset a
//   draft's media_attachments still references — precisely so a scheduled
//   post keeps publishing after its asset is deleted. A `deleted_at IS NULL`
//   filter in this path used to turn that scenario into a permanently failed
//   publish ("could not be found"), defeating the sweep's design.
//
// Also pinned: a truly missing asset (hard-deleted / wrong workspace) still
// throws, and zernio-sourced attachments pass through untouched.
// ---------------------------------------------------------------------------

const presignSpy = vi.fn();
const uploadSpy = vi.fn();
vi.mock("@/lib/zernio", () => ({
  getMediaPresignedUrl: (...a: unknown[]) => presignSpy(...a),
  uploadToPresignedUrl: (...a: unknown[]) => uploadSpy(...a),
}));

const { ensureZernioMediaAttachments } = await import("@/lib/media-library");

type AssetRow = Record<string, unknown>;
let assets: AssetRow[] = [];
let downloadFails = false;

// Minimal fake covering the exact chain the resolver uses:
// from("media_assets").select().eq().eq()[.is()].maybeSingle() + storage download.
function makeClient(): SupabaseClient {
  return {
    from: () => {
      const filters: Array<[string, unknown]> = [];
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (k: string, v: unknown) => {
          filters.push([k, v]);
          return builder;
        },
        is: (k: string, v: unknown) => {
          filters.push([k, v]);
          return builder;
        },
        maybeSingle: async () => ({
          data:
            assets.find((r) => filters.every(([k, v]) => r[k] === v)) ?? null,
          error: null,
        }),
      };
      return builder;
    },
    storage: {
      from: () => ({
        download: async () =>
          downloadFails
            ? { data: null, error: new Error("object missing") }
            : { data: new Blob(["bytes"]), error: null },
      }),
    },
  } as unknown as SupabaseClient;
}

function seedAsset(over: AssetRow = {}) {
  assets = [
    {
      id: "a1",
      workspace_id: "ws1",
      filename: "photo.jpg",
      mime_type: "image/jpeg",
      size_bytes: 1024,
      media_type: "image",
      storage_bucket: "media-assets",
      storage_path: "ws1/2026-07-01/photo.jpg",
      created_at: "2026-07-01T00:00:00.000Z",
      deleted_at: null,
      ...over,
    },
  ];
}

const libraryAttachment: PostMediaAttachment = {
  id: "asset:a1",
  source: "library",
  assetId: "a1",
  name: "photo.jpg",
  mimeType: "image/jpeg",
  size: 1024,
  type: "image",
  uploadedAt: "2026-07-01T00:00:00.000Z",
} as PostMediaAttachment;

beforeEach(() => {
  assets = [];
  downloadFails = false;
  presignSpy.mockReset();
  uploadSpy.mockReset();
  presignSpy.mockResolvedValue({
    uploadUrl: "https://zernio.test/upload",
    publicUrl: "https://media.zernio.com/temp/photo.jpg",
    key: "temp/photo.jpg",
  });
  uploadSpy.mockResolvedValue(undefined);
});

describe("ensureZernioMediaAttachments", () => {
  test("a SOFT-DELETED library asset still resolves for publishing (sweep kept the bytes)", async () => {
    // The scenario the media GC was designed around: schedule a post with a
    // library image, then delete the image from the library (soft-delete).
    seedAsset({ deleted_at: "2026-07-02T00:00:00.000Z" });

    const out = await ensureZernioMediaAttachments({
      sb: makeClient(),
      workspaceId: "ws1",
      attachments: [libraryAttachment],
    });

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      source: "zernio",
      assetId: "a1",
      url: "https://media.zernio.com/temp/photo.jpg",
      type: "image",
    });
    expect(uploadSpy).toHaveBeenCalledOnce();
  });

  test("a live (not deleted) library asset resolves as before", async () => {
    seedAsset();

    const out = await ensureZernioMediaAttachments({
      sb: makeClient(),
      workspaceId: "ws1",
      attachments: [libraryAttachment],
    });

    expect(out[0]).toMatchObject({ source: "zernio", assetId: "a1" });
  });

  test("a truly missing asset row still fails the publish with 'could not be found'", async () => {
    assets = []; // hard-deleted (or never existed)

    await expect(
      ensureZernioMediaAttachments({
        sb: makeClient(),
        workspaceId: "ws1",
        attachments: [libraryAttachment],
      }),
    ).rejects.toThrow(/could not be found/i);
  });

  test("an asset from another workspace is not resolvable", async () => {
    seedAsset({ workspace_id: "other-ws" });

    await expect(
      ensureZernioMediaAttachments({
        sb: makeClient(),
        workspaceId: "ws1",
        attachments: [libraryAttachment],
      }),
    ).rejects.toThrow(/could not be found/i);
  });

  test("a missing storage object (bytes actually purged) fails with a media load error", async () => {
    seedAsset({ deleted_at: "2026-01-01T00:00:00.000Z" });
    downloadFails = true;

    await expect(
      ensureZernioMediaAttachments({
        sb: makeClient(),
        workspaceId: "ws1",
        attachments: [libraryAttachment],
      }),
    ).rejects.toThrow(/could not load/i);
  });

  test("zernio-sourced attachments pass through without touching the database", async () => {
    const zernio = {
      id: "m1",
      source: "zernio",
      name: "photo.jpg",
      mimeType: "image/jpeg",
      size: 1024,
      type: "image",
      url: "https://media.zernio.com/temp/photo.jpg",
      uploadedAt: "2026-07-03T10:00:00.000Z",
    } as PostMediaAttachment;

    const out = await ensureZernioMediaAttachments({
      sb: makeClient(),
      workspaceId: "ws1",
      attachments: [zernio],
    });

    expect(out).toEqual([zernio]);
    expect(presignSpy).not.toHaveBeenCalled();
  });
});
