import { deriveDraftTitle, isAutoDerivedTitle } from "@/lib/draft-title";
import {
  leadMagnetContextFromMeta,
  type LeadMagnetStamp,
} from "@/lib/draft-lead-magnet";
import {
  DRAFT_MUTATION_CONFLICT,
  DRAFT_SCHEDULING_CONFLICT,
  earliestZernioMediaExpiry,
  SCHEDULABLE_DRAFT_STATUSES,
} from "@/lib/draft-scheduling";
import {
  postMediaAttachmentsSchema,
  validatePostMediaSet,
  type PostMediaAttachment,
} from "@/lib/post-media";
import { resolveDraftKind } from "@/lib/post-type";
import { localDateForInstant } from "@/lib/schedule-local-date";
import { LINKEDIN_MAX_CHARS } from "@/lib/zernio";
import {
  draftEgressBody,
  mergeDraftContentFormat,
  type ContentFormat,
} from "@/lib/markdown/mode";

export const BOARD_DRAFT_STATUSES = ["idea", "drafting", "ready", "posted"] as const;
const MAX_MUTATION_ATTEMPTS = 3;
export type BoardDraftStatus = (typeof BOARD_DRAFT_STATUSES)[number];
export type DraftStatus = BoardDraftStatus | "pending_review" | "rejected";
export type DraftKind = "post" | "hook" | "lead_magnet";
export type DraftScheduleStatus = "scheduled" | "publishing" | "published" | "failed" | null;

export type DraftRecord = {
  id: string;
  title: string | null;
  body: string;
  meta: Record<string, unknown> | null;
  kind: DraftKind;
  status: DraftStatus;
  planToPostOn: string | null;
  chatId: string | null;
  createdAt: string;
  mediaAttachments: PostMediaAttachment[];
  scheduledAt: string | null;
  scheduleStatus: DraftScheduleStatus;
  firstComment: string | null;
  publishedAt: string | null;
  publishError: string | null;
  postingSlotId?: string | null;
  postingSlotOccurrenceDate?: string | null;
  lifecycleVersion: number;
};

export type DraftLifecycleRepository = {
  readonly workspaceId: string;
  list(input?: { status?: BoardDraftStatus; limit?: number }): Promise<DraftRecord[]>;
  find(id: string): Promise<DraftRecord | null>;
  saveChatDraft(input: {
    chatId: string;
    kind: DraftKind;
    status: DraftStatus;
    title: string | null;
    body: string;
    meta: Record<string, unknown> | null;
    mediaAttachments: PostMediaAttachment[];
    savedBy: string | null;
    lineageOrigin?: {
      weekPlanItemId?: string;
      opportunityId?: string;
    };
  }): Promise<
    | { outcome: "saved" | "deduped"; draft: DraftRecord }
    | { outcome: "chat_not_found" }
  >;
  create(input: {
    chatId: string | null;
    kind: DraftKind;
    status: DraftStatus;
    title: string | null;
    body: string;
    meta: Record<string, unknown> | null;
    mediaAttachments: PostMediaAttachment[];
    planToPostOn?: string | null;
    savedBy?: string | null;
  }): Promise<DraftRecord>;
  // A standalone draft (chat_id always null — no chat exists to dedup within,
  // unlike saveChatDraft) with the SAME retry-safety saveChatDraft already
  // has for chat-saved ones: create_draft (MCP) and POST /api/drafts ("New
  // post") both go through here, and a retried call — an MCP client
  // re-sending after a timeout, a double-click — should return the existing
  // draft instead of inserting a twin. Content-only dedup key, windowed
  // (not "ever"), since there's no chat_id to scope against.
  createStandalone(input: {
    kind: DraftKind;
    status: DraftStatus;
    title: string | null;
    body: string;
    meta: Record<string, unknown> | null;
    mediaAttachments: PostMediaAttachment[];
    planToPostOn?: string | null;
  }): Promise<{ outcome: "saved" | "deduped"; draft: DraftRecord }>;
  mutate(
    id: string,
    patch: Partial<DraftRecord>,
    expectedVersion: number,
  ): Promise<DraftRecord | "stale">;
  remove(id: string): Promise<"removed" | "conflict" | "not_found">;
  schedule(
    id: string,
    patch: {
      scheduledAt: string;
      firstComment: string | null;
      planToPostOn: string;
      expectedVersion: number;
      postingSlotId?: string | null;
      postingSlotOccurrenceDate?: string | null;
      requireNoActiveQueueBooking?: boolean;
    },
  ): Promise<DraftRecord | "stale">;
  cancelSchedule(id: string): Promise<DraftRecord | "conflict">;
};

export type DraftRejectionReason =
  | "not_found"
  | "locked"
  | "not_connected"
  | "past_schedule"
  | "invalid_status"
  | "linkedin_length"
  | "invalid_media"
  | "media_expiry"
  | "not_scheduled"
  | "invalid_transition"
  | "stale_write";

export type DraftCommandOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: DraftRejectionReason; message: string; status: number };

function accepted<T>(value: T): DraftCommandOutcome<T> {
  return { ok: true, value };
}

function rejected<T>(
  reason: DraftRejectionReason,
  message: string,
  status: number,
): DraftCommandOutcome<T> {
  return { ok: false, reason, message, status };
}

export function defaultDraftStatus(kind: DraftKind): "idea" | "drafting" {
  return kind === "hook" ? "idea" : "drafting";
}

export class DraftLifecycle {
  constructor(
    private readonly repository: DraftLifecycleRepository,
    private readonly dependencies: {
      canPublish?: () => Promise<boolean>;
      now?: () => number;
    } = {},
  ) {
    if (!repository.workspaceId.trim()) {
      throw new Error("DraftLifecycle requires workspace identity.");
    }
  }

  list(input?: { status?: BoardDraftStatus; limit?: number }) {
    return this.repository.list(input);
  }

  find(id: string) {
    return this.repository.find(id);
  }

  create(input: {
    body: string;
    title?: string;
    kind?: DraftKind;
    status?: BoardDraftStatus;
    planToPostOn?: string | null;
    mediaAttachments?: PostMediaAttachment[];
    // Board-authored drafts carry no chat context, so meta is normally null.
    // The "New post" form can attach a chosen lead-magnet giveaway here
    // (meta.lead_magnet), resolved server-side from the picker's selection.
    meta?: Record<string, unknown> | null;
  }) {
    const kind = resolveDraftKind(input.kind, input.body, {
      hasLeadMagnet: leadMagnetContextFromMeta(input.meta) !== null,
    });
    return this.repository.createStandalone({
      kind,
      status: input.status ?? defaultDraftStatus(kind),
      title: input.title?.trim() || deriveDraftTitle(input.body),
      body: input.body,
      meta: input.meta ?? null,
      mediaAttachments: input.mediaAttachments ?? [],
      ...(input.planToPostOn !== undefined
        ? { planToPostOn: input.planToPostOn }
        : {}),
    });
  }

  createForReview(input: {
    body: string;
    kind: DraftKind;
    meta: Record<string, unknown>;
    chatId?: string | null;
  }) {
    return this.repository.create({
      chatId: input.chatId ?? null,
      kind: input.kind,
      status: "pending_review",
      title: deriveDraftTitle(input.body),
      body: input.body,
      meta: input.meta,
      mediaAttachments: [],
    });
  }

  async saveFromChat(input: {
    chatId: string;
    body: string;
    title?: string;
    kind?: DraftKind;
    meta?: Record<string, unknown>;
    mediaAttachments?: PostMediaAttachment[];
    savedBy?: string | null;
    lineageOrigin?: {
      weekPlanItemId?: string;
      opportunityId?: string;
    };
  }): Promise<
    DraftCommandOutcome<{ draft: DraftRecord; deduped: boolean }>
  > {
    const kind = resolveDraftKind(input.kind, input.body, {
      hasLeadMagnet: leadMagnetContextFromMeta(input.meta) !== null,
    });
    const result = await this.repository.saveChatDraft({
      chatId: input.chatId,
      kind,
      status: defaultDraftStatus(kind),
      title: input.title ?? null,
      body: input.body,
      meta: input.meta ?? null,
      mediaAttachments: input.mediaAttachments ?? [],
      savedBy: input.savedBy ?? null,
      lineageOrigin: input.lineageOrigin,
    });
    if (result.outcome === "chat_not_found") {
      return rejected("not_found", "Chat not found", 404);
    }
    return accepted({
      draft: result.draft,
      deduped: result.outcome === "deduped",
    });
  }

  async enrichPendingReview(
    id: string,
    input: {
      meta: Record<string, unknown>;
      mediaAttachments?: PostMediaAttachment[];
    },
  ): Promise<DraftCommandOutcome<DraftRecord>> {
    const current = await this.repository.find(id);
    if (!current) return rejected("not_found", "Draft not found", 404);
    if (current.status !== "pending_review") {
      return rejected(
        "invalid_transition",
        "This draft is no longer pending review.",
        409,
      );
    }
    const result = await this.repository.mutate(
      id,
      {
        meta: input.meta,
        ...(input.mediaAttachments !== undefined
          ? { mediaAttachments: input.mediaAttachments }
          : {}),
      },
      current.lifecycleVersion,
    );
    if (result === "stale") {
      return rejected(
        "stale_write",
        "This draft changed while its review assets were being saved.",
        409,
      );
    }
    return accepted(result);
  }

  async mutate(
    id: string,
    input: {
      body?: string;
      title?: string | null;
      status?: DraftStatus;
      kind?: DraftKind;
      planToPostOn?: string | null;
      mediaAttachments?: PostMediaAttachment[];
      contentFormat?: ContentFormat;
      // Giveaway attach/detach: a stamp sets meta.lead_magnet, null clears it,
      // undefined leaves it alone.
      leadMagnet?: LeadMagnetStamp | null;
    },
  ): Promise<DraftCommandOutcome<DraftRecord>> {
    const outcome = await this.mutateWithPrevious(id, input);
    return outcome.ok ? accepted(outcome.value.draft) : outcome;
  }

  async mutateWithPrevious(
    id: string,
    input: {
      body?: string;
      title?: string | null;
      status?: DraftStatus;
      kind?: DraftKind;
      planToPostOn?: string | null;
      mediaAttachments?: PostMediaAttachment[];
      contentFormat?: ContentFormat;
      leadMagnet?: LeadMagnetStamp | null;
    },
  ): Promise<
    DraftCommandOutcome<{ draft: DraftRecord; previous: DraftRecord }>
  > {
    // The public PATCH command does not accept a client lifecycle version. Its
    // read-then-CAS write is an internal safety boundary, so a one-off CAS miss
    // means the command raced another valid server command—not that the user's
    // edit is stale. Replay the whole command against the newest row so every
    // publish/review guard is evaluated again before applying the patch.
    for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt += 1) {
      const current = await this.repository.find(id);
      if (!current) return rejected("not_found", "Draft not found", 404);
      // 'scheduled' is included alongside 'publishing'/'published': without it,
      // a status mutation (e.g. the editor's Status dropdown) could flip a
      // still-queued draft to 'posted' while schedule_status/scheduled_at stay
      // untouched — the board then shows "Posted" (implying already published)
      // even though the cron (which reads only schedule_status/scheduled_at,
      // never status) will still auto-publish it later at the original time.
      // The user must cancel the schedule first, which is the one write path
      // (cancelSchedule) that's allowed to touch a scheduled row.
      if (
        current.scheduleStatus === "scheduled" ||
        current.scheduleStatus === "publishing" ||
        current.scheduleStatus === "published"
      ) {
        return rejected("locked", DRAFT_MUTATION_CONFLICT, 409);
      }
      if (
        (current.status === "pending_review" || current.status === "rejected") &&
        input.status === undefined
      ) {
        return rejected(
          "invalid_transition",
          "Review drafts must be approved or rejected before they can be changed.",
          409,
        );
      }
      if (input.status !== undefined) {
        const boardStatus = (BOARD_DRAFT_STATUSES as readonly string[]).includes(
          input.status,
        );
        const allowedReviewOutcome =
          current.status === "pending_review" &&
          (input.status === "ready" || input.status === "rejected");
        const allowedBoardMove =
          (BOARD_DRAFT_STATUSES as readonly string[]).includes(current.status) &&
          boardStatus;
        if (!allowedReviewOutcome && !allowedBoardMove) {
          return rejected(
            "invalid_transition",
            "This draft can't move to that review status.",
            409,
          );
        }
      }

      const patch: Partial<DraftRecord> = {};
      if (input.body !== undefined) patch.body = input.body;
      if (input.status !== undefined) patch.status = input.status;
      if (input.kind !== undefined) patch.kind = input.kind;
      if (input.planToPostOn !== undefined) patch.planToPostOn = input.planToPostOn;
      if (input.mediaAttachments !== undefined) patch.mediaAttachments = input.mediaAttachments;
      if (input.contentFormat !== undefined || input.leadMagnet !== undefined) {
        // Both commands merge into meta — build it once so they compose instead
        // of overwriting each other. leadMagnet: a stamp attaches/replaces the
        // giveaway, null detaches it, undefined leaves meta.lead_magnet alone.
        const meta =
          input.contentFormat !== undefined
            ? mergeDraftContentFormat(current.meta, input.contentFormat)
            : { ...(current.meta ?? {}) };
        if (input.leadMagnet === null) delete meta.lead_magnet;
        else if (input.leadMagnet !== undefined) meta.lead_magnet = input.leadMagnet;
        patch.meta = meta;
      }
      const effectiveMeta = patch.meta !== undefined ? patch.meta : current.meta;
      const effectiveKind = resolveDraftKind(input.kind ?? current.kind, input.body ?? current.body, {
        hasLeadMagnet: leadMagnetContextFromMeta(effectiveMeta) !== null,
      });
      if (effectiveKind !== current.kind) patch.kind = effectiveKind;
      if (input.title !== undefined) {
        patch.title = input.title?.trim() || deriveDraftTitle(input.body ?? current.body);
      } else if (
        input.body !== undefined &&
        isAutoDerivedTitle(current.title, current.body)
      ) {
        patch.title = deriveDraftTitle(input.body);
      }

      const result = await this.repository.mutate(
        id,
        patch,
        current.lifecycleVersion,
      );
      if (result !== "stale") {
        return accepted({ draft: result, previous: current });
      }
    }

    return rejected(
      "stale_write",
      "This draft kept changing while the request was being saved. Refresh and try again.",
      409,
    );
  }

  async remove(id: string): Promise<DraftCommandOutcome<{ id: string }>> {
    const result = await this.repository.remove(id);
    if (result === "not_found") return rejected("not_found", "Draft not found", 404);
    if (result === "conflict") return rejected("locked", DRAFT_MUTATION_CONFLICT, 409);
    return accepted({ id });
  }

  async schedule(
    id: string,
    input: {
      scheduledAt: string;
      planToPostOn?: string;
      timezone?: string;
      firstComment?: string | null;
      postingSlotId?: string | null;
      postingSlotOccurrenceDate?: string | null;
      preserveExistingQueue?: boolean;
    },
  ): Promise<DraftCommandOutcome<DraftRecord>> {
    if (!(await this.dependencies.canPublish?.())) {
      return rejected(
        "not_connected",
        "Connect your LinkedIn account in Integrations to schedule posts.",
        409,
      );
    }
    const when = new Date(input.scheduledAt).getTime();
    if (!Number.isFinite(when) || when < (this.dependencies.now?.() ?? Date.now()) - 60_000) {
      return rejected("past_schedule", "Pick a time in the future.", 400);
    }
    const draft = await this.repository.find(id);
    if (!draft) return rejected("not_found", "Draft not found", 404);
    if (
      input.preserveExistingQueue &&
      (draft.scheduleStatus === "scheduled" ||
        draft.scheduleStatus === "publishing") &&
      draft.postingSlotId &&
      draft.postingSlotOccurrenceDate
    ) {
      return accepted(draft);
    }
    if (
      draft.scheduleStatus === "publishing" ||
      draft.scheduleStatus === "published"
    ) {
      return rejected("locked", DRAFT_SCHEDULING_CONFLICT, 409);
    }
    // Measure the caption LinkedIn will actually receive. A markdown-model draft
    // (meta.markdown) publishes as its markdownToLinkedIn form, whose Unicode
    // bold chars are astral (2 UTF-16 units each) — so we must cap-check the
    // CONVERTED length here too, matching the publish path, or an over-limit post
    // could pass schedule and then fail at publish.
    const publishBody = draftEgressBody(draft.body, draft.meta);
    if (publishBody.length > LINKEDIN_MAX_CHARS) {
      return rejected(
        "linkedin_length",
        `This post is ${publishBody.length} characters — LinkedIn's limit is ${LINKEDIN_MAX_CHARS}. Trim ${publishBody.length - LINKEDIN_MAX_CHARS} characters, then schedule.`,
        400,
      );
    }
    if (!(SCHEDULABLE_DRAFT_STATUSES as readonly string[]).includes(draft.status)) {
      return rejected("invalid_status", "Only unsent board drafts can be scheduled.", 409);
    }
    const parsedMedia = postMediaAttachmentsSchema.safeParse(draft.mediaAttachments);
    if (!parsedMedia.success) {
      return rejected(
        "invalid_media",
        "One attached media file is invalid. Remove it and upload again.",
        400,
      );
    }
    const mediaError = validatePostMediaSet(parsedMedia.data);
    if (mediaError) return rejected("invalid_media", mediaError, 400);
    const expiresAt = earliestZernioMediaExpiry(parsedMedia.data);
    if (expiresAt !== null && when > expiresAt) {
      return rejected(
        "media_expiry",
        "Direct media uploads must publish within 7 days. Pick a sooner time, or attach media from the library instead.",
        400,
      );
    }
    const planToPostOn =
      input.planToPostOn ?? localDateForInstant(input.scheduledAt, input.timezone);
    const result = await this.repository.schedule(id, {
      scheduledAt: input.scheduledAt,
      firstComment: input.firstComment?.trim() || null,
      planToPostOn,
      expectedVersion: draft.lifecycleVersion,
      postingSlotId: input.postingSlotId ?? null,
      postingSlotOccurrenceDate: input.postingSlotOccurrenceDate ?? null,
      requireNoActiveQueueBooking: input.preserveExistingQueue,
    });
    if (result === "stale") {
      return rejected(
        "stale_write",
        `This draft changed or started publishing before the schedule was saved. ${DRAFT_SCHEDULING_CONFLICT}`,
        409,
      );
    }
    return accepted(result);
  }

  async cancelSchedule(id: string): Promise<DraftCommandOutcome<DraftRecord>> {
    const result = await this.repository.cancelSchedule(id);
    if (result === "conflict") {
      return rejected(
        "not_scheduled",
        "This post can't be unscheduled anymore.",
        409,
      );
    }
    return accepted(result);
  }
}

export function draftRecordToApi(draft: DraftRecord) {
  return {
    id: draft.id,
    title: draft.title,
    body: draft.body,
    meta: draft.meta,
    kind: draft.kind,
    status: draft.status,
    plan_to_post_on: draft.planToPostOn,
    chat_id: draft.chatId,
    created_at: draft.createdAt,
    media_attachments: draft.mediaAttachments,
    scheduled_at: draft.scheduledAt,
    schedule_status: draft.scheduleStatus,
    first_comment: draft.firstComment,
    published_at: draft.publishedAt,
    publish_error: draft.publishError,
    posting_slot_id: draft.postingSlotId ?? null,
    posting_slot_occurrence_date: draft.postingSlotOccurrenceDate ?? null,
    lifecycle_version: draft.lifecycleVersion,
  };
}
