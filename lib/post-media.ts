import { z } from "zod";

export type PostMediaType = "image" | "video" | "document";

export type PostMediaAttachment = {
  id: string;
  source?: "zernio" | "library";
  assetId?: string | null;
  name: string;
  mimeType: string;
  size: number;
  type: PostMediaType;
  url?: string | null;
  key?: string | null;
  storageBucket?: string | null;
  storagePath?: string | null;
  previewUrl?: string | null;
  uploadedAt: string;
};

const IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const VIDEO_MIME = new Set(["video/mp4", "video/quicktime", "video/x-msvideo", "video/webm"]);
const DOCUMENT_MIME = new Set(["application/pdf"]);

export const POST_MEDIA_MAX_BYTES: Record<PostMediaType, number> = {
  image: 5 * 1024 * 1024 * 1024,
  video: 5 * 1024 * 1024 * 1024,
  document: 100 * 1024 * 1024,
};

export const MAX_LINKEDIN_IMAGES = 20;

const filenameSchema = z.string().trim().min(1).max(240);
const contentTypeSchema = z.string().trim().toLowerCase().min(3).max(120);
const isoDatetimeSchema = z
  .string()
  .trim()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/,
    "Invalid ISO datetime",
  )
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid ISO datetime")
  .transform((value) => new Date(value).toISOString());

export const postMediaAttachmentSchema = z.object({
  id: z.string().trim().min(1).max(120),
  source: z.enum(["zernio", "library"]).optional().default("zernio"),
  assetId: z.string().trim().min(1).max(120).nullable().optional(),
  name: filenameSchema,
  mimeType: contentTypeSchema,
  size: z.number().int().nonnegative(),
  type: z.enum(["image", "video", "document"]),
  url: z.string().url().nullable().optional(),
  key: z.string().trim().max(500).nullable().optional(),
  storageBucket: z.string().trim().max(120).nullable().optional(),
  storagePath: z.string().trim().max(800).nullable().optional(),
  uploadedAt: isoDatetimeSchema,
}).superRefine((attachment, ctx) => {
  const source = attachment.source ?? "zernio";
  if (source === "zernio" && !attachment.url) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Uploaded media must include a Zernio URL.",
      path: ["url"],
    });
  }
  if (source === "library" && !attachment.assetId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Library media must include an asset id.",
      path: ["assetId"],
    });
  }
});

export const postMediaAttachmentsSchema = z
  .array(postMediaAttachmentSchema)
  .max(MAX_LINKEDIN_IMAGES)
  .superRefine((attachments, ctx) => {
    const error = validatePostMediaSet(attachments);
    if (error) ctx.addIssue({ code: z.ZodIssueCode.custom, message: error });
  });

export function classifyPostMedia(contentType: string): PostMediaType | null {
  const normalized = contentType.trim().toLowerCase();
  if (IMAGE_MIME.has(normalized)) return "image";
  if (VIDEO_MIME.has(normalized)) return "video";
  if (DOCUMENT_MIME.has(normalized)) return "document";
  return null;
}

export function validatePostMediaFile(input: {
  name: string;
  contentType: string;
  size: number;
}): { ok: true; type: PostMediaType; normalizedContentType: string } | { ok: false; error: string } {
  const filename = filenameSchema.safeParse(input.name);
  if (!filename.success) return { ok: false, error: "Give the file a valid name." };

  const contentType = contentTypeSchema.safeParse(input.contentType);
  if (!contentType.success) return { ok: false, error: "Unsupported file type." };

  if (!Number.isFinite(input.size) || input.size <= 0) {
    return { ok: false, error: "This file is empty." };
  }

  const type = classifyPostMedia(contentType.data);
  if (!type) {
    return {
      ok: false,
      error: "Unsupported media type. Use JPG, PNG, GIF, WebP, MP4, MOV, AVI, WebM, or PDF.",
    };
  }

  const max = POST_MEDIA_MAX_BYTES[type];
  if (input.size > max) {
    return {
      ok: false,
      error:
        type === "document"
          ? "PDFs can be up to 100 MB."
          : "Images and videos can be up to 5 GB.",
    };
  }

  return { ok: true, type, normalizedContentType: contentType.data };
}

export function validatePostMediaSet(attachments: PostMediaAttachment[]): string | null {
  if (attachments.length === 0) return null;

  const types = new Set(attachments.map((a) => a.type));
  if (types.size > 1) {
    return "LinkedIn media cannot mix images, videos, and PDFs in one post.";
  }

  const type = attachments[0]?.type;
  if (type === "image" && attachments.length > MAX_LINKEDIN_IMAGES) {
    return `LinkedIn supports up to ${MAX_LINKEDIN_IMAGES} images per post.`;
  }
  if (type === "video" && attachments.length > 1) {
    return "LinkedIn supports one video per post.";
  }
  if (type === "document" && attachments.length > 1) {
    return "LinkedIn supports one PDF per post.";
  }

  for (const a of attachments) {
    if ((a.source ?? "zernio") === "zernio" && !isZernioMediaUrl(a.url)) {
      return "Media must be uploaded through Zernio.";
    }
    if (a.source === "library" && !a.assetId) {
      return "Library media is missing its asset id.";
    }
    const file = validatePostMediaFile({
      name: a.name,
      contentType: a.mimeType,
      size: a.size,
    });
    if (!file.ok) return file.error;
    if (file.type !== a.type) return "Media type does not match the uploaded file.";
  }

  return null;
}

export function isZernioMediaUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "media.zernio.com";
  } catch {
    return false;
  }
}

export function toZernioMediaItems(attachments: PostMediaAttachment[]): Array<{ url: string; type: PostMediaType }> {
  return attachments.map((a) => {
    if (!a.url || !isZernioMediaUrl(a.url)) {
      throw new Error("Media must be uploaded through Zernio before publishing.");
    }
    return { url: a.url, type: a.type };
  });
}
