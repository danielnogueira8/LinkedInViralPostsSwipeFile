import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  classifyPostMedia,
  postMediaAttachmentSchema,
  validatePostMediaFile,
  validatePostMediaSet,
  toZernioMediaItems,
  mediaAttachmentsForPersistence,
  type PostMediaAttachment,
} from "@/lib/post-media";
import {
  mediaAssetToAttachment,
  validateLibraryMediaFile,
} from "@/lib/media-library";

const uploadedAt = "2026-07-05T12:00:00.000Z";

function media(overrides: Partial<PostMediaAttachment>): PostMediaAttachment {
  return {
    id: "m1",
    name: "photo.jpg",
    mimeType: "image/jpeg",
    size: 1024,
    type: "image",
    url: "https://media.zernio.com/temp/photo.jpg",
    key: "temp/photo.jpg",
    uploadedAt,
    ...overrides,
  };
}

describe("post media validation", () => {
  test("classifies Zernio-supported LinkedIn media types", () => {
    expect(classifyPostMedia("image/jpeg")).toBe("image");
    expect(classifyPostMedia("image/png")).toBe("image");
    expect(classifyPostMedia("image/gif")).toBe("image");
    expect(classifyPostMedia("image/webp")).toBe("image");
    expect(classifyPostMedia("video/mp4")).toBe("video");
    expect(classifyPostMedia("video/quicktime")).toBe("video");
    expect(classifyPostMedia("video/webm")).toBe("video");
    expect(classifyPostMedia("application/pdf")).toBe("document");
  });

  // REGRESSION: AVI used to be accepted here but rejected by
  // validateLibraryMediaFile, so a direct-attach AVI could pass initial
  // validation and only fail (or be silently rejected by LinkedIn) later,
  // wasting a publish attempt. Rejected at the single source of truth now.
  test("REGRESSION: AVI (video/x-msvideo) is rejected — LinkedIn's publish API doesn't support it", () => {
    expect(classifyPostMedia("video/x-msvideo")).toBeNull();
  });

  test("rejects unsupported media types and empty files", () => {
    expect(validatePostMediaFile({ name: "x.svg", contentType: "image/svg+xml", size: 100 }).ok).toBe(false);
    expect(validatePostMediaFile({ name: "x.jpg", contentType: "image/jpeg", size: 0 }).ok).toBe(false);
  });

  test("rejects arbitrary public URLs that were not uploaded through Zernio", () => {
    expect(validatePostMediaSet([media({ url: "https://example.com/photo.jpg" })])).toMatch(/Zernio/i);
  });

  test("does not include a browser-only preview URL in a persistence payload", () => {
    const payload = mediaAttachmentsForPersistence([
      media({ previewUrl: "blob:https://app.example/temporary-preview" }),
    ]);
    expect(payload).toEqual([
      expect.objectContaining({ id: "m1", url: "https://media.zernio.com/temp/photo.jpg" }),
    ]);
    expect(payload[0]).not.toHaveProperty("previewUrl");
  });

  test("allows image carousels but rejects mixed media", () => {
    const err = validatePostMediaSet([
      media({ id: "img", type: "image", mimeType: "image/png", name: "a.png" }),
      media({ id: "vid", type: "video", mimeType: "video/mp4", name: "b.mp4" }),
    ]);
    expect(err).toMatch(/cannot mix/i);
  });

  test("rejects more than one video or PDF", () => {
    expect(
      validatePostMediaSet([
        media({ id: "v1", type: "video", mimeType: "video/mp4", name: "a.mp4" }),
        media({ id: "v2", type: "video", mimeType: "video/mp4", name: "b.mp4" }),
      ]),
    ).toMatch(/one video/i);
    expect(
      validatePostMediaSet([
        media({ id: "p1", type: "document", mimeType: "application/pdf", name: "a.pdf" }),
        media({ id: "p2", type: "document", mimeType: "application/pdf", name: "b.pdf" }),
      ]),
    ).toMatch(/one PDF/i);
  });

  test("maps attachments to Zernio mediaItems", () => {
    expect(toZernioMediaItems([media({})])).toEqual([
      { url: "https://media.zernio.com/temp/photo.jpg", type: "image" },
    ]);
  });

  test("allows library media attachments without a Zernio URL", () => {
    const err = validatePostMediaSet([
      media({
        source: "library",
        assetId: "asset-1",
        url: null,
        storageBucket: "media-assets",
        storagePath: "ws/asset.jpg",
      }),
    ]);
    expect(err).toBeNull();
  });

  test("normalizes Supabase offset timestamps on media attachments", () => {
    const parsed = postMediaAttachmentSchema.parse(
      media({
        source: "library",
        assetId: "asset-1",
        url: null,
        uploadedAt: "2026-07-06T14:09:05.123+00:00",
      }),
    );

    expect(parsed.uploadedAt).toBe("2026-07-06T14:09:05.123Z");
  });

  test("refuses to publish library media before it is converted to Zernio", () => {
    expect(() =>
      toZernioMediaItems([
        media({
          source: "library",
          assetId: "asset-1",
          url: null,
          storageBucket: "media-assets",
          storagePath: "ws/asset.jpg",
        }),
      ]),
    ).toThrow(/Zernio/i);
  });
});

describe("media library validation", () => {
  test("keeps library uploads within the app/bucket limits", () => {
    expect(validateLibraryMediaFile({ name: "photo.jpg", contentType: "image/jpeg", size: 1024 }).ok).toBe(true);
    expect(
      validateLibraryMediaFile({ name: "huge.jpg", contentType: "image/jpeg", size: 51 * 1024 * 1024 }).ok,
    ).toBe(false);
  });

  test("matches the manually-created bucket MIME list", () => {
    expect(validateLibraryMediaFile({ name: "old.avi", contentType: "video/x-msvideo", size: 1024 }).ok).toBe(false);
    expect(validateLibraryMediaFile({ name: "clip.webm", contentType: "video/webm", size: 1024 }).ok).toBe(true);
  });

  test("maps a saved asset to a draft library attachment", () => {
    expect(
      mediaAssetToAttachment({
        id: "a1",
        filename: "photo.jpg",
        mime_type: "image/jpeg",
        size_bytes: 1024,
        media_type: "image",
        storage_bucket: "media-assets",
        storage_path: "ws/photo.jpg",
        created_at: "2026-07-06T10:00:00.000+00:00",
        signedUrl: "https://example.supabase.co/signed",
      }),
    ).toMatchObject({
      source: "library",
      assetId: "a1",
      name: "photo.jpg",
      previewUrl: "https://example.supabase.co/signed",
      uploadedAt: "2026-07-06T10:00:00.000Z",
    });
  });
});

// ---------------------------------------------------------------------------
// The media host has to be in the CSP, or the composer preview breaks.
//
// This is a real defect, not a hypothetical: img-src listed licdn, clerk,
// supabase and vercel but NOT the host every post attachment actually lives
// on. Attaching an image showed a blob: preview while it uploaded, then swapped
// in the uploaded URL and the browser blocked it — an image that attaches
// successfully and then renders as a broken icon.
//
// The host is read out of the validator rather than hardcoded here, so moving
// the media host fails this test instead of silently breaking previews again.
// ---------------------------------------------------------------------------
describe("the media host is reachable from the browser", () => {
  const MEDIA_HOST = (() => {
    const source = readFileSync(
      path.join(process.cwd(), "lib/post-media.ts"),
      "utf8",
    );
    return /hostname === "([^"]+)"/.exec(source)?.[1] ?? "";
  })();

  const CONFIG = readFileSync(
    path.join(process.cwd(), "next.config.ts"),
    "utf8",
  );

  /**
   * The ENTRIES of a directive, with comments stripped.
   *
   * Stripping matters: the comment explaining why this host is allowed names
   * the host, so a raw substring check passes on the prose alone. Verified by
   * mutation — without this, deleting the actual entry still passed.
   */
  function directive(name: string): string {
    const block =
      new RegExp(`"${name}":\\s*\\[([\\s\\S]*?)\\]`).exec(CONFIG)?.[1] ?? "";
    return block
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
  }

  test("the validator pins a host at all", () => {
    // Guards the regex above: a refactor that stops matching would make every
    // assertion below vacuously pass against an empty string.
    expect(MEDIA_HOST).toBe("media.zernio.com");
  });

  test("img-src allows the host attachments are served from", () => {
    // toZernioMediaItems REFUSES to publish media on any other host, so this
    // is the only origin a post image can ever have.
    expect(directive("img-src")).toContain(MEDIA_HOST);
  });

  test("connect-src allows the direct upload PUT", () => {
    // Without it the upload silently falls back to proxying every byte through
    // our own server, and files over the client's 4 MB proxy cap fail with a
    // message that misattributes the cause.
    expect(directive("connect-src")).toContain(MEDIA_HOST);
  });
});
