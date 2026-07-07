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
    ? `Resource details to reflect if useful: ${deliverables.slice(0, 4).join("; ")}.`
    : "If the source design has small supporting text, make it reinforce the resource promise.";

  return [
    "Use the attached image as a layout and style reference. Recreate the same composition, mood, hierarchy, spacing, typography feel, and visual structure, but fully rebrand it for a different LinkedIn lead magnet.",
    "Keep the original image's aspect ratio and broad layout. Do not copy the original creator's logo, brand name, personal name, exact text, watermarks, or proprietary marks.",
    "Replace all visible text with new text for this lead magnet.",
    `Brand/logo text: "${brandName}".`,
    `Top pill or small label: "FREE RESOURCE" or "FREE TOOLKIT", whichever fits the design better.`,
    `Main headline: "${title}". Shorten only if needed for clean layout.`,
    `Primary CTA button/text: Comment "${keyword}" to get it.`,
    'Secondary CTA button/text: "GET THE FREE RESOURCE".',
    deliverableLine,
    "Make it premium, clean, high contrast, and uncluttered. Avoid garbled text. If text will not fit, simplify the wording instead of shrinking it too much.",
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

export function inferAspectRatioFromImageBytes(): string {
  // Keep v1 dependency-free. OpenRouter accepts normalized ratios; LinkedIn lead
  // magnet source graphics are overwhelmingly square, and providers preserve the
  // reference composition when input_references is supplied.
  return "1:1";
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
    const aspectRatio = inferAspectRatioFromImageBytes();
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
