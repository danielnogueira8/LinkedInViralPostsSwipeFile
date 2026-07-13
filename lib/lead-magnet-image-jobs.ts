import type { SupabaseClient } from "@supabase/supabase-js";
import { enqueueBackgroundJob } from "@/lib/background-jobs";
import type { Artifact } from "@/lib/agent/contracts";
import {
  DRAFT_MUTATION_CONFLICT,
  SCHEDULABLE_SCHEDULE_STATUS_FILTER,
} from "@/lib/draft-scheduling";
import {
  generateAndStoreLeadMagnetImage,
  type LeadMagnetImageAuthor,
  type LeadMagnetImageContext,
  type SourcePostImage,
} from "@/lib/lead-magnet-image-generation";
import type { PostMediaAttachment } from "@/lib/post-media";

type Db = SupabaseClient;

export type LeadMagnetImageJobTarget =
  | {
      kind: "chat_message_artifact";
      chatId: string;
      artifactId: string;
    }
  | {
      kind: "chat_artifact";
      artifactId: string;
    };

export type LeadMagnetImageJobPayload = {
  target: LeadMagnetImageJobTarget;
  sourceImage: SourcePostImage;
  leadMagnet: LeadMagnetImageContext;
  artifact: Artifact;
  author: LeadMagnetImageAuthor | null;
};

export function artifactMediaAttachments(artifact: Artifact): PostMediaAttachment[] {
  const raw =
    (artifact as Artifact & { media_attachments?: unknown }).media_attachments ??
    (artifact.meta as { media_attachments?: unknown } | undefined)?.media_attachments;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is PostMediaAttachment => {
    if (!item || typeof item !== "object") return false;
    const a = item as Partial<PostMediaAttachment>;
    return (
      typeof a.id === "string" &&
      typeof a.name === "string" &&
      typeof a.mimeType === "string" &&
      typeof a.type === "string" &&
      typeof a.uploadedAt === "string"
    );
  });
}

export function withLeadMagnetImageAttachment(
  artifact: Artifact,
  attachment: PostMediaAttachment,
  generatedImageMeta: Record<string, unknown>,
): Artifact {
  const attachments = [...artifactMediaAttachments(artifact), attachment];
  return {
    ...artifact,
    media_attachments: attachments,
    meta: {
      ...(artifact.meta ?? {}),
      media_attachments: attachments,
      generated_lead_magnet_image: generatedImageMeta,
    },
  } as Artifact;
}

export function withLeadMagnetImageMeta(
  artifact: Artifact,
  generatedImageMeta: Record<string, unknown>,
): Artifact {
  return {
    ...artifact,
    meta: {
      ...(artifact.meta ?? {}),
      generated_lead_magnet_image: generatedImageMeta,
    },
  };
}

export async function enqueueLeadMagnetImageJob(opts: {
  sb?: Db;
  workspaceId: string;
  target: LeadMagnetImageJobTarget;
  sourceImage: SourcePostImage;
  leadMagnet: LeadMagnetImageContext;
  artifact: Artifact;
  author: LeadMagnetImageAuthor | null;
}): Promise<{ jobId: string; queuedMeta: Record<string, unknown> }> {
  const job = await enqueueBackgroundJob({
    sb: opts.sb,
    workspaceId: opts.workspaceId,
    type: "lead_magnet_image",
    payload: {
      target: opts.target,
      sourceImage: opts.sourceImage,
      leadMagnet: opts.leadMagnet,
      artifact: opts.artifact,
      author: opts.author,
    },
    progress: {
      stage: "Queued",
      artifactId: opts.target.artifactId,
      sourcePostId: opts.sourceImage.postId,
      leadMagnetId: opts.leadMagnet.id ?? null,
    },
  });

  return {
    jobId: job.id,
    queuedMeta: {
      status: "queued",
      job_id: job.id,
      source_post_id: opts.sourceImage.postId,
      source_image_url: opts.sourceImage.imageUrl,
      lead_magnet_id: opts.leadMagnet.id ?? null,
      lead_magnet_title: opts.leadMagnet.title,
    },
  };
}

export function parseLeadMagnetImageJobPayload(
  payload: Record<string, unknown>,
): LeadMagnetImageJobPayload {
  const target = payload.target;
  const sourceImage = payload.sourceImage;
  const leadMagnet = payload.leadMagnet;
  const artifact = payload.artifact;

  if (!target || typeof target !== "object") {
    throw new Error("Invalid lead magnet image job payload: missing target.");
  }
  if (!sourceImage || typeof sourceImage !== "object") {
    throw new Error("Invalid lead magnet image job payload: missing sourceImage.");
  }
  if (!leadMagnet || typeof leadMagnet !== "object") {
    throw new Error("Invalid lead magnet image job payload: missing leadMagnet.");
  }
  if (!artifact || typeof artifact !== "object") {
    throw new Error("Invalid lead magnet image job payload: missing artifact.");
  }

  const t = target as Partial<LeadMagnetImageJobTarget> & {
    chatId?: unknown;
    artifactId?: unknown;
  };
  const s = sourceImage as Partial<SourcePostImage>;
  const l = leadMagnet as Partial<LeadMagnetImageContext>;
  const a = artifact as Partial<Artifact>;

  if (t.kind !== "chat_message_artifact" && t.kind !== "chat_artifact") {
    throw new Error("Invalid lead magnet image job payload: unsupported target.");
  }
  if (typeof t.artifactId !== "string" || !t.artifactId.trim()) {
    throw new Error("Invalid lead magnet image job payload: missing artifact id.");
  }
  if (t.kind === "chat_message_artifact" && (typeof t.chatId !== "string" || !t.chatId.trim())) {
    throw new Error("Invalid lead magnet image job payload: missing chat id.");
  }
  if (
    typeof s.postId !== "string" ||
    typeof s.imageUrl !== "string" ||
    !s.imageUrl.trim()
  ) {
    throw new Error("Invalid lead magnet image job payload: missing source image.");
  }
  if (typeof l.title !== "string" || !l.title.trim()) {
    throw new Error("Invalid lead magnet image job payload: missing lead magnet title.");
  }
  if (
    typeof a.id !== "string" ||
    (a.kind !== "post" && a.kind !== "hook" && a.kind !== "cite") ||
    typeof a.title !== "string" ||
    typeof a.body !== "string"
  ) {
    throw new Error("Invalid lead magnet image job payload: malformed artifact.");
  }

  return {
    target: t.kind === "chat_message_artifact"
      ? { kind: t.kind, chatId: t.chatId as string, artifactId: t.artifactId }
      : { kind: t.kind, artifactId: t.artifactId },
    sourceImage: {
      postId: s.postId,
      imageUrl: s.imageUrl,
      mediaType: typeof s.mediaType === "string" ? s.mediaType : null,
    },
    leadMagnet: {
      id: typeof l.id === "string" ? l.id : null,
      title: l.title,
      metadata:
        l.metadata && typeof l.metadata === "object"
          ? (l.metadata as LeadMagnetImageContext["metadata"])
          : undefined,
      ctaKeyword:
        typeof l.ctaKeyword === "string" && l.ctaKeyword.trim()
          ? l.ctaKeyword.trim()
          : undefined,
    },
    artifact: {
      id: a.id,
      kind: a.kind,
      title: a.title,
      body: a.body,
      meta: a.meta && typeof a.meta === "object" ? (a.meta as Record<string, unknown>) : {},
      ...("media_attachments" in a
        ? { media_attachments: (a as Artifact & { media_attachments?: unknown }).media_attachments }
        : {}),
    } as Artifact,
    author:
      payload.author && typeof payload.author === "object"
        ? {
            name:
              typeof (payload.author as { name?: unknown }).name === "string"
                ? ((payload.author as { name?: string }).name ?? null)
                : null,
          }
        : null,
  };
}

export async function runLeadMagnetImageJob(opts: {
  sb: Db;
  workspaceId: string;
  payload: LeadMagnetImageJobPayload;
  signal?: AbortSignal;
}): Promise<{ artifact: Artifact; ok: boolean; reason?: string }> {
  const generated = await generateAndStoreLeadMagnetImage({
    sb: opts.sb,
    workspaceId: opts.workspaceId,
    sourceImage: opts.payload.sourceImage,
    leadMagnet: opts.payload.leadMagnet,
    artifact: opts.payload.artifact,
    author: opts.payload.author,
    signal: opts.signal,
  });
  const artifact = generated.ok
    ? withLeadMagnetImageAttachment(
        opts.payload.artifact,
        generated.attachment,
        generated.meta,
      )
    : withLeadMagnetImageMeta(opts.payload.artifact, generated.meta);

  await persistLeadMagnetImageArtifact({
    sb: opts.sb,
    workspaceId: opts.workspaceId,
    target: opts.payload.target,
    artifact,
  });

  return {
    artifact,
    ok: generated.ok,
    ...(generated.ok ? {} : { reason: generated.reason }),
  };
}

export async function persistLeadMagnetImageArtifact(opts: {
  sb: Db;
  workspaceId: string;
  target: LeadMagnetImageJobTarget;
  artifact: Artifact;
}): Promise<void> {
  const mediaAttachments = artifactMediaAttachments(opts.artifact);
  if (opts.target.kind === "chat_artifact") {
    const patch: Record<string, unknown> = {
      meta: opts.artifact.meta ?? {},
    };
    if (mediaAttachments.length) patch.media_attachments = mediaAttachments;
    const { data, error } = await opts.sb
      .from("chat_artifacts")
      .update(patch)
      .eq("workspace_id", opts.workspaceId)
      .eq("id", opts.target.artifactId)
      .or(SCHEDULABLE_SCHEDULE_STATUS_FILTER)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error(DRAFT_MUTATION_CONFLICT);
    return;
  }

  const { data, error } = await opts.sb
    .from("chat_messages")
    .select("id, artifacts")
    .eq("workspace_id", opts.workspaceId)
    .eq("chat_id", opts.target.chatId)
    .eq("role", "assistant")
    .not("artifacts", "is", null)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw error;

  const rows = (data ?? []) as Array<{ id: string; artifacts: unknown }>;
  for (const row of rows) {
    if (!Array.isArray(row.artifacts)) continue;
    const nextArtifacts = row.artifacts.map((item) => {
      if (!item || typeof item !== "object") return item;
      return (item as { id?: unknown }).id === opts.target.artifactId
        ? opts.artifact
        : item;
    });
    const changed = nextArtifacts.some(
      (item, idx) => item !== (row.artifacts as unknown[])[idx],
    );
    if (!changed) continue;
    const update = await opts.sb
      .from("chat_messages")
      .update({ artifacts: nextArtifacts })
      .eq("workspace_id", opts.workspaceId)
      .eq("id", row.id);
    if (update.error) throw update.error;
    return;
  }

  throw new Error("Could not find the chat artifact to attach the generated image.");
}
