import type { SupabaseClient } from "@supabase/supabase-js";
import {
  IMAGE_GENERATION_MODEL,
  generateImage,
  logOpenRouterUsage,
} from "@/lib/openrouter";
import {
  MEDIA_LIBRARY_BUCKET,
  MEDIA_LIBRARY_MAX_FILE_BYTES,
  mediaAssetToAttachment,
  storagePathForMedia,
  workspaceMediaUsage,
  MEDIA_LIBRARY_QUOTA_BYTES,
  type MediaAsset,
} from "@/lib/media-library";
import type { PostMediaAttachment } from "@/lib/post-media";
import type { LeadMagnetMetadata } from "@/lib/lead-magnets";
import type { Artifact } from "@/lib/agent/run";

const SOURCE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const GENERATED_IMAGE_FILENAME = "lead-magnet-image.png";

export type SourcePostImage = {
  postId: string;
  imageUrl: string;
  mediaType: string | null;
};

export type LeadMagnetImageAuthor = {
  name: string | null;
};

export type LeadMagnetImageContext = {
  id?: string | null;
  title: string;
  metadata?: LeadMagnetMetadata;
};

export type LeadMagnetImageResult =
  | { ok: true; attachment: PostMediaAttachment; meta: Record<string, unknown> }
  | { ok: false; reason: string; meta: Record<string, unknown> };

export function shouldGenerateLeadMagnetImage(opts: {
  artifact: Pick<Artifact, "kind">;
  leadMagnet: { id?: string | null; title: string } | null;
  sourceImage: SourcePostImage | null;
}): boolean {
  return (
    opts.artifact.kind === "post" &&
    !!opts.leadMagnet?.title.trim() &&
    opts.sourceImage?.mediaType === "image" &&
    !!opts.sourceImage.imageUrl
  );
}

export function inferCommentKeyword(draftBody: string, leadMagnetTitle: string): string {
  const quoted = Array.from(draftBody.matchAll(/["“”']([A-Z][A-Z0-9_-]{2,24})["“”']/g))
    .map((m) => m[1])
    .find((word) => !["FREE", "LINK", "DM"].includes(word));
  if (quoted) return quoted;
  const titleWord = leadMagnetTitle
    .toUpperCase()
    .match(/\b[A-Z][A-Z0-9]{3,14}\b/g)
    ?.find(
      (word) =>
        ![
          "THE",
          "WITH",
          "FROM",
          "THAT",
          "THIS",
          "YOUR",
          "BEST",
          "WAYS",
          "PROMPTS",
          "CREATE",
        ].includes(word),
    );
  return titleWord ?? "GUIDE";
}

export function buildLeadMagnetImagePrompt(opts: {
  leadMagnet: LeadMagnetImageContext;
  draftBody: string;
  author: LeadMagnetImageAuthor | null;
  aspectRatio: string;
}): string {
  const title = opts.leadMagnet.title.trim() || inferGenericLeadMagnetTitle(opts.draftBody);
  const deliverables = opts.leadMagnet.metadata?.deliverables ?? [];
  const keyword = inferCommentKeyword(opts.draftBody, title);
  const brandName = opts.author?.name?.trim() || "SwipeIn";
  const deliverableLine = deliverables.length
    ? `Resource details to use only if the source already has supporting text slots: ${deliverables.slice(0, 4).join("; ")}.`
    : "If the source design has supporting text slots, make them reinforce the resource promise.";

  return [
    "Use the attached image as the source image to edit, not just loose inspiration. Preserve the same canvas, aspect ratio, composition, number of major elements, element positions, spacing, icon sizes, typography weight, background, and overall visual hierarchy.",
    "Make minimal targeted changes. Do not add new names, logos, pills, buttons, CTA rows, badges, decorative icons, extra illustrations, or extra sections unless the source image already has matching slots for them.",
    "Replace only the visible text or icons that must change for this lead magnet. Keep text in the same locations and with similar length/weight whenever possible. If there is no headline slot, do not invent a headline.",
    "If the source image contains a person/avatar silhouette, replace it with a simple AI/brain/spark-style avatar in the same exact position, size, and visual weight. Do not add the user's name to replace that avatar.",
    "Do not copy the original creator's personal name, exact text, watermark, or proprietary brand mark. If a platform logo exists, keep a generic platform-like mark in the same style rather than adding a new creator brand.",
    `Only if the source already has a brand/name text slot, use this replacement: "${brandName}". Otherwise do not add a name.`,
    `Only if the source already has a top pill or small label slot, use: "FREE RESOURCE" or "FREE TOOLKIT".`,
    `Only if the source already has a headline/title slot, use: "${title}". Shorten only if needed for the existing layout.`,
    `Only if the source already has a primary CTA/button text slot, use: Comment "${keyword}" to get it.`,
    'Only if the source already has a secondary CTA/button text slot, use: "GET THE FREE RESOURCE".',
    deliverableLine,
    "The final image should look like a careful adaptation of the original, not a newly designed AI graphic. Avoid glossy stock icons, random extra labels, garbled text, and clutter. If text will not fit, simplify the wording instead of adding new layout.",
    `Output aspect ratio: ${opts.aspectRatio}.`,
  ].join("\n");
}

export function genericLeadMagnetImageContextFromDraft(
  artifact: Pick<Artifact, "title" | "body">,
): LeadMagnetImageContext {
  return {
    id: null,
    title: inferGenericLeadMagnetTitle(`${artifact.title}\n${artifact.body}`),
    metadata: {
      summary:
        "Generic lead magnet image adaptation based on the generated draft because no saved lead magnet resource was available.",
      deliverables: inferDraftDeliverables(artifact.body),
    },
  };
}

function inferGenericLeadMagnetTitle(text: string): string {
  const quoted = Array.from(text.matchAll(/["“”']([^"“”']{4,70})["“”']/g))
    .map((m) => m[1].trim())
    .find(
      (value) =>
        /\b(guide|playbook|kit|toolkit|checklist|template|resource|audit)\b/i.test(value) &&
        !/^[A-Z0-9_-]{2,24}$/.test(value),
    );
  if (quoted) return quoted;
  const line = text
    .split(/\n+/)
    .map((part) => part.trim())
    .find((part) => part.length >= 8 && part.length <= 90);
  return line?.replace(/^#+\s*/, "") ?? "Free Resource";
}

function inferDraftDeliverables(body: string): string[] {
  return body
    .split(/\n+/)
    .map((line) => line.trim().replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, ""))
    .filter((line) => /\b(checklist|template|guide|playbook|prompts?|framework|audit|scorecard|swipe)\b/i.test(line))
    .slice(0, 4);
}

type ImageDimensions = { width: number; height: number };

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

function readPngDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 24) return null;
  if (
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  ) {
    return null;
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function readGifDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 10) return null;
  const signature = bytes.subarray(0, 6).toString("ascii");
  if (signature !== "GIF87a" && signature !== "GIF89a") return null;
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  return width > 0 && height > 0 ? { width, height } : null;
}

function readJpegDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof && length >= 7) {
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += length;
  }
  return null;
}

function readWebpDimensions(bytes: Buffer): ImageDimensions | null {
  if (
    bytes.length < 30 ||
    bytes.subarray(0, 4).toString("ascii") !== "RIFF" ||
    bytes.subarray(8, 12).toString("ascii") !== "WEBP"
  ) {
    return null;
  }
  const chunk = bytes.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X" && bytes.length >= 30) {
    const width =
      1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
    const height =
      1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (chunk === "VP8 " && bytes.length >= 30) {
    const width = bytes.readUInt16LE(26) & 0x3fff;
    const height = bytes.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (chunk === "VP8L" && bytes.length >= 25) {
    const b0 = bytes[21];
    const b1 = bytes[22];
    const b2 = bytes[23];
    const b3 = bytes[24];
    const width = 1 + (((b1 & 0x3f) << 8) | b0);
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    return width > 0 && height > 0 ? { width, height } : null;
  }
  return null;
}

export function imageDimensionsFromBytes(
  bytes: Buffer,
  mimeType: string,
): ImageDimensions | null {
  const type = mimeType.toLowerCase();
  if (type === "image/png") return readPngDimensions(bytes);
  if (type === "image/jpeg" || type === "image/jpg") return readJpegDimensions(bytes);
  if (type === "image/webp") return readWebpDimensions(bytes);
  if (type === "image/gif") return readGifDimensions(bytes);
  return (
    readPngDimensions(bytes) ??
    readJpegDimensions(bytes) ??
    readWebpDimensions(bytes) ??
    readGifDimensions(bytes)
  );
}

export function inferAspectRatioFromImageBytes(
  bytes: Buffer,
  mimeType: string,
): string {
  const dimensions = imageDimensionsFromBytes(bytes, mimeType);
  if (!dimensions) return "1:1";
  const divisor = gcd(dimensions.width, dimensions.height);
  const width = dimensions.width / divisor;
  const height = dimensions.height / divisor;
  if (width <= 0 || height <= 0) return "1:1";
  return `${width}:${height}`;
}

export async function fetchSourceImageDataUrl(
  url: string,
  signal?: AbortSignal,
): Promise<{ dataUrl: string; bytes: Buffer; mimeType: string }> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`Source image could not be fetched (${res.status}).`);
  }
  const mimeType = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (!mimeType || !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mimeType)) {
    throw new Error("Source media is not a supported image.");
  }
  const length = Number(res.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > SOURCE_IMAGE_MAX_BYTES) {
    throw new Error("Source image is too large to adapt.");
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > SOURCE_IMAGE_MAX_BYTES) {
    throw new Error("Source image is too large to adapt.");
  }
  return {
    dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}`,
    bytes,
    mimeType,
  };
}

export async function generateAndStoreLeadMagnetImage(opts: {
  sb: SupabaseClient;
  workspaceId: string;
  sourceImage: SourcePostImage;
  leadMagnet: LeadMagnetImageContext;
  artifact: Artifact;
  author: LeadMagnetImageAuthor | null;
  signal?: AbortSignal;
}): Promise<LeadMagnetImageResult> {
  const baseMeta = {
    status: "skipped",
    model: IMAGE_GENERATION_MODEL,
    source_post_id: opts.sourceImage.postId,
    source_image_url: opts.sourceImage.imageUrl,
    lead_magnet_id: opts.leadMagnet.id ?? null,
    lead_magnet_title: opts.leadMagnet.title,
  };
  try {
    const source = await fetchSourceImageDataUrl(opts.sourceImage.imageUrl, opts.signal);
    const aspectRatio = inferAspectRatioFromImageBytes(source.bytes, source.mimeType);
    const prompt = buildLeadMagnetImagePrompt({
      leadMagnet: opts.leadMagnet,
      draftBody: opts.artifact.body,
      author: opts.author,
      aspectRatio,
    });
    const generated = await generateImage({
      prompt,
      referenceDataUrl: source.dataUrl,
      model: IMAGE_GENERATION_MODEL,
      aspectRatio,
      outputFormat: "png",
      signal: opts.signal,
    });

    await logOpenRouterUsage(
      "lead_magnet_image_generate",
      IMAGE_GENERATION_MODEL,
      generated.usage,
      opts.workspaceId,
      {
        source_post_id: opts.sourceImage.postId,
        lead_magnet_id: opts.leadMagnet.id ?? null,
        lead_magnet_title: opts.leadMagnet.title,
        artifact_id: opts.artifact.id,
        exact_image_cost: generated.usage?.cost ?? null,
      },
    );

    const imageBytes = Buffer.from(generated.b64Json, "base64");
    if (imageBytes.length <= 0) throw new Error("Generated image was empty.");
    if (imageBytes.length > MEDIA_LIBRARY_MAX_FILE_BYTES) {
      throw new Error("Generated image is too large for the media library.");
    }
    const usedBytes = await workspaceMediaUsage(opts.sb, opts.workspaceId);
    if (usedBytes + imageBytes.length > MEDIA_LIBRARY_QUOTA_BYTES) {
      throw new Error("Media library quota is full.");
    }

    const storagePath = storagePathForMedia(opts.workspaceId, GENERATED_IMAGE_FILENAME);
    const upload = await opts.sb.storage
      .from(MEDIA_LIBRARY_BUCKET)
      .upload(storagePath, imageBytes, {
        contentType: generated.mimeType,
        upsert: false,
      });
    if (upload.error) throw upload.error;

    const { data, error } = await opts.sb
      .from("media_assets")
      .insert({
        workspace_id: opts.workspaceId,
        filename: GENERATED_IMAGE_FILENAME,
        mime_type: generated.mimeType,
        size_bytes: imageBytes.length,
        media_type: "image",
        storage_bucket: MEDIA_LIBRARY_BUCKET,
        storage_path: storagePath,
      })
      .select("id, filename, mime_type, size_bytes, media_type, storage_bucket, storage_path, created_at")
      .single();
    if (error) throw error;

    const attachment = mediaAssetToAttachment({
      ...(data as MediaAsset),
      signedUrl: `/api/media-assets/${(data as MediaAsset).id}/preview`,
    });
    return {
      ok: true,
      attachment,
      meta: {
        ...baseMeta,
        status: "ready",
        media_asset_id: (data as MediaAsset).id,
        cost_usd: generated.usage?.cost ?? null,
        aspect_ratio: aspectRatio,
      },
    };
  } catch (e) {
    const reason = (e as Error)?.message || "Image could not be generated.";
    console.log(
      JSON.stringify({
        lead_magnet_image_generate_skipped: {
          workspace_id: opts.workspaceId,
          source_post_id: opts.sourceImage.postId,
          lead_magnet_id: opts.leadMagnet.id ?? null,
          lead_magnet_title: opts.leadMagnet.title,
          reason,
        },
      }),
    );
    return {
      ok: false,
      reason,
      meta: {
        ...baseMeta,
        status: "failed",
        reason,
      },
    };
  }
}
