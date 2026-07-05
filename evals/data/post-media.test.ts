import { describe, expect, test } from "vitest";
import {
  classifyPostMedia,
  validatePostMediaFile,
  validatePostMediaSet,
  toZernioMediaItems,
  type PostMediaAttachment,
} from "@/lib/post-media";

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
    expect(classifyPostMedia("video/x-msvideo")).toBe("video");
    expect(classifyPostMedia("video/webm")).toBe("video");
    expect(classifyPostMedia("application/pdf")).toBe("document");
  });

  test("rejects unsupported media types and empty files", () => {
    expect(validatePostMediaFile({ name: "x.svg", contentType: "image/svg+xml", size: 100 }).ok).toBe(false);
    expect(validatePostMediaFile({ name: "x.jpg", contentType: "image/jpeg", size: 0 }).ok).toBe(false);
  });

  test("rejects arbitrary public URLs that were not uploaded through Zernio", () => {
    expect(validatePostMediaSet([media({ url: "https://example.com/photo.jpg" })])).toMatch(/Zernio/i);
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
});
