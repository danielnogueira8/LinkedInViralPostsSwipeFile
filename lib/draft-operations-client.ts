import { z } from "zod";
import { parseJsonResponse } from "@/lib/api-fetch";
import type { ContentFormat } from "@/lib/markdown/mode";
import type { PostMediaAttachment } from "@/lib/post-media";
import type {
  BoardDraftStatus,
  DraftKind,
  DraftStatus,
} from "@/lib/draft-lifecycle";
import type { DraftViewRow } from "@/lib/draft-view";

type FetchDraftOperation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type DraftUpdateCommand = {
  body?: string;
  title?: string | null;
  status?: DraftStatus;
  kind?: DraftKind;
  plan_to_post_on?: string | null;
  media_attachments?: PostMediaAttachment[];
  content_format?: ContentFormat;
};

export type DraftCreateCommand = {
  body: string;
  title?: string;
  kind?: DraftKind;
  lead_magnet_id?: string | null;
  status?: BoardDraftStatus;
  plan_to_post_on?: string | null;
  media_attachments?: PostMediaAttachment[];
};

export type SaveArtifactAsDraftCommand = {
  body: string;
  title?: string;
  kind?: DraftKind;
  meta?: Record<string, unknown>;
  media_attachments?: PostMediaAttachment[];
};

export type DraftScheduleCommand = {
  scheduledAt: string;
  planToPostOn: string;
  timezone?: string;
  firstComment: string | null;
};

export type ScheduledDraftState = {
  scheduledAt: string;
  scheduleStatus: "scheduled";
  planToPostOn: string;
  firstComment: string | null;
};

export type DraftQueueCommand = {
  firstComment: string | null;
  timezone: string;
};

export type QueuedDraftState = Omit<ScheduledDraftState, "scheduleStatus"> & {
  scheduleStatus: "scheduled" | "publishing";
  timezone: string;
  postingSlotId: string;
  postingSlotOccurrenceDate: string;
};

export type UnscheduledDraftState = {
  scheduledAt: null;
  scheduleStatus: null;
  firstComment: null;
};

const errorSchema = z.object({
  ok: z.literal(false),
  error: z.string().optional(),
});
const draftApiRecordSchema = z
  .object({
    id: z.string(),
    title: z.string().nullable(),
    body: z.string(),
    kind: z.string(),
    status: z.string(),
    plan_to_post_on: z.string().nullable(),
    chat_id: z.string().nullable(),
    created_at: z.string(),
    meta: z.unknown().optional(),
    media_attachments: z.unknown().optional(),
    scheduled_at: z.string().nullable().optional(),
    schedule_status: z.string().nullable().optional(),
    first_comment: z.string().nullable().optional(),
    published_at: z.string().nullable().optional(),
    publish_error: z.string().nullable().optional(),
    posting_slot_id: z.string().nullable().optional(),
    posting_slot_occurrence_date: z.string().nullable().optional(),
  })
  .passthrough();
const createResponseSchema = z.discriminatedUnion("ok", [
  errorSchema,
  z.object({
    ok: z.literal(true),
    deduped: z.boolean().optional(),
    draft: draftApiRecordSchema,
  }),
]);
const saveFromChatResponseSchema = z.discriminatedUnion("ok", [
  errorSchema,
  z.object({
    ok: z.literal(true),
    deduped: z.boolean().optional(),
    artifact: draftApiRecordSchema,
  }),
]);
const updateResponseSchema = z.discriminatedUnion("ok", [
  errorSchema,
  z.object({
    ok: z.literal(true),
    draft: draftApiRecordSchema,
  }),
]);
const scheduleResponseSchema = z.discriminatedUnion("ok", [
  errorSchema,
  z.object({
    ok: z.literal(true),
    scheduledAt: z.string(),
    scheduleStatus: z.literal("scheduled"),
    planToPostOn: z.string(),
    firstComment: z.string().nullable(),
  }),
]);
const queueResponseSchema = z.discriminatedUnion("ok", [
  errorSchema,
  z.object({
    ok: z.literal(true),
    scheduledAt: z.string(),
    scheduleStatus: z.enum(["scheduled", "publishing"]),
    planToPostOn: z.string(),
    firstComment: z.string().nullable(),
    timezone: z.string(),
    postingSlotId: z.string(),
    postingSlotOccurrenceDate: z.string(),
  }),
]);
const unscheduleResponseSchema = z.discriminatedUnion("ok", [
  errorSchema,
  z.object({ ok: z.literal(true) }),
]);

async function readDraftOperationResponse<T extends z.ZodTypeAny>(
  response: Response,
  schema: T,
  fallbackError: string,
): Promise<Extract<z.infer<T>, { ok: true }>> {
  const value = await parseJsonResponse<unknown>(response, fallbackError);
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid response from server");
  const data = parsed.data as z.infer<T> & { ok: boolean; error?: string };
  if (!data.ok) throw new Error(data.error || fallbackError);
  return data as Extract<z.infer<T>, { ok: true }>;
}

async function fetchDraftOperation(
  fetcher: FetchDraftOperation,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetcher(input, init);
  } catch {
    // Draft create/save routes are idempotent and Draft mutations use guarded
    // lifecycle commands, so one transport-only retry is safe. HTTP failures
    // are returned and parsed without retrying.
    return fetcher(input, init);
  }
}

export function createDraftOperationsClient(
  fetcher: FetchDraftOperation = fetch,
) {
  return {
    async find(draftId: string): Promise<DraftViewRow> {
      const response = await fetchDraftOperation(
        fetcher,
        `/api/drafts/${draftId}`,
        { method: "GET" },
      );
      const value = await readDraftOperationResponse(
        response,
        updateResponseSchema,
        "Failed to load post",
      );
      return value.draft as DraftViewRow;
    },

    async create(
      command: DraftCreateCommand,
    ): Promise<{ draft: DraftViewRow; deduped: boolean }> {
      const response = await fetchDraftOperation(fetcher, "/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
      const value = await readDraftOperationResponse(
        response,
        createResponseSchema,
        "Failed to create post",
      );
      return {
        draft: value.draft as DraftViewRow,
        deduped: value.deduped === true,
      };
    },

    async saveFromChat(
      chatId: string,
      command: SaveArtifactAsDraftCommand,
      options: { fallbackError?: string } = {},
    ): Promise<{ draft: DraftViewRow; deduped: boolean }> {
      const response = await fetchDraftOperation(
        fetcher,
        `/api/chats/${chatId}/artifacts`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(command),
        },
      );
      const value = await readDraftOperationResponse(
        response,
        saveFromChatResponseSchema,
        options.fallbackError ?? "Failed to save",
      );
      return {
        draft: value.artifact as DraftViewRow,
        deduped: value.deduped === true,
      };
    },

    async update(
      draftId: string,
      command: DraftUpdateCommand,
      options: { fallbackError?: string } = {},
    ): Promise<DraftViewRow> {
      const response = await fetchDraftOperation(
        fetcher,
        `/api/drafts/${draftId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(command),
        },
      );
      const value = await readDraftOperationResponse(
        response,
        updateResponseSchema,
        options.fallbackError ?? "Failed to update draft",
      );
      return value.draft as DraftViewRow;
    },

    async schedule(
      draftId: string,
      command: DraftScheduleCommand,
    ): Promise<ScheduledDraftState> {
      const response = await fetchDraftOperation(
        fetcher,
        `/api/drafts/${draftId}/schedule`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(command),
        },
      );
      const value = await readDraftOperationResponse(
        response,
        scheduleResponseSchema,
        "Couldn't schedule.",
      );
      return {
        scheduledAt: value.scheduledAt,
        scheduleStatus: value.scheduleStatus,
        planToPostOn: value.planToPostOn,
        firstComment: value.firstComment,
      };
    },

    async queue(
      draftId: string,
      command: DraftQueueCommand,
    ): Promise<QueuedDraftState> {
      const response = await fetchDraftOperation(
        fetcher,
        `/api/drafts/${draftId}/queue`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(command),
        },
      );
      const value = await readDraftOperationResponse(
        response,
        queueResponseSchema,
        "Couldn't add this post to the queue.",
      );
      return {
        scheduledAt: value.scheduledAt,
        scheduleStatus: value.scheduleStatus,
        planToPostOn: value.planToPostOn,
        firstComment: value.firstComment,
        timezone: value.timezone,
        postingSlotId: value.postingSlotId,
        postingSlotOccurrenceDate: value.postingSlotOccurrenceDate,
      };
    },

    async unschedule(draftId: string): Promise<UnscheduledDraftState> {
      // Cancellation is not idempotent at the Draft lifecycle seam: if the
      // first response is lost after commit, retrying produces a misleading
      // "not scheduled" conflict even though the command succeeded.
      const response = await fetcher(`/api/drafts/${draftId}/schedule`, {
        method: "DELETE",
      });
      await readDraftOperationResponse(
        response,
        unscheduleResponseSchema,
        "Couldn't unschedule.",
      );
      return {
        scheduledAt: null,
        scheduleStatus: null,
        firstComment: null,
      };
    },
  };
}

export const draftOperations = createDraftOperationsClient();
