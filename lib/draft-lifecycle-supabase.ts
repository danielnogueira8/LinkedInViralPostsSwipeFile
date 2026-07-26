import type { SupabaseClient } from "@supabase/supabase-js";
import {
  BOARD_DRAFT_STATUSES,
  type DraftLifecycleRepository,
  type DraftRecord,
} from "@/lib/draft-lifecycle";
import {
  SCHEDULABLE_DRAFT_STATUSES,
  SCHEDULABLE_SCHEDULE_STATUS_FILTER,
  MUTATABLE_SCHEDULE_STATUS_FILTER,
} from "@/lib/draft-scheduling";
import type { PostMediaAttachment } from "@/lib/post-media";
import { recordSavedDraftLineage } from "@/lib/content-learning/generation-lineage";

const DRAFT_COLUMNS =
  "id, title, body, meta, kind, status, plan_to_post_on, chat_id, created_at, media_attachments, scheduled_at, schedule_status, first_comment, published_at, publish_error, posting_slot_id, posting_slot_occurrence_date, lifecycle_version";

type DraftRow = {
  id: string;
  title: string | null;
  body: string;
  meta: Record<string, unknown> | null;
  kind: DraftRecord["kind"];
  status: DraftRecord["status"];
  plan_to_post_on: string | null;
  chat_id: string | null;
  created_at: string;
  media_attachments: PostMediaAttachment[] | null;
  scheduled_at: string | null;
  schedule_status: DraftRecord["scheduleStatus"];
  first_comment: string | null;
  published_at: string | null;
  publish_error: string | null;
  posting_slot_id: string | null;
  posting_slot_occurrence_date: string | null;
  lifecycle_version?: number | null;
};

function fromRow(row: DraftRow): DraftRecord {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    meta: row.meta,
    kind: row.kind,
    status: row.status,
    planToPostOn: row.plan_to_post_on,
    chatId: row.chat_id,
    createdAt: row.created_at,
    mediaAttachments: row.media_attachments ?? [],
    scheduledAt: row.scheduled_at,
    scheduleStatus: row.schedule_status,
    firstComment: row.first_comment,
    publishedAt: row.published_at,
    publishError: row.publish_error,
    postingSlotId: row.posting_slot_id,
    postingSlotOccurrenceDate: row.posting_slot_occurrence_date,
    lifecycleVersion: Number(row.lifecycle_version ?? 0),
  };
}

function toPatch(patch: Partial<DraftRecord>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.title !== undefined) row.title = patch.title;
  if (patch.body !== undefined) row.body = patch.body;
  if (patch.meta !== undefined) row.meta = patch.meta;
  if (patch.kind !== undefined) row.kind = patch.kind;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.planToPostOn !== undefined) row.plan_to_post_on = patch.planToPostOn;
  if (patch.mediaAttachments !== undefined) row.media_attachments = patch.mediaAttachments;
  return row;
}

export function createSupabaseDraftLifecycleRepository(
  db: SupabaseClient,
  workspaceId: string,
): DraftLifecycleRepository {
  if (!workspaceId.trim()) throw new Error("workspace identity required");

  return {
    workspaceId,

    async list(input) {
      let query = db
        .from("chat_artifacts")
        .select(DRAFT_COLUMNS)
        .eq("workspace_id", workspaceId)
        .order("created_at", { ascending: false })
        .limit(input?.limit ?? 200);
      query = input?.status
        ? query.eq("status", input.status)
        : query.in("status", BOARD_DRAFT_STATUSES as readonly string[]);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []).map((row) => fromRow(row as unknown as DraftRow));
    },

    async find(id) {
      const { data, error } = await db
        .from("chat_artifacts")
        .select(DRAFT_COLUMNS)
        .eq("id", id)
        .eq("workspace_id", workspaceId)
        .maybeSingle();
      if (error) throw error;
      return data ? fromRow(data as unknown as DraftRow) : null;
    },

    async saveChatDraft(input) {
      const { data, error } = await db.rpc("save_chat_draft", {
        p_workspace_id: workspaceId,
        p_chat_id: input.chatId,
        p_kind: input.kind,
        p_status: input.status,
        p_title: input.title,
        p_body: input.body,
        p_meta: input.meta,
        p_media_attachments: input.mediaAttachments,
        p_saved_by: input.savedBy,
      });
      if (error) throw error;
      const result = data as unknown as {
        outcome: "saved" | "deduped" | "chat_not_found";
        draft?: DraftRow;
      };
      if (result.outcome === "chat_not_found") {
        return { outcome: "chat_not_found" as const };
      }
      if (!result.draft) throw new Error("save_chat_draft returned no draft");
      const draft = fromRow(result.draft);
      await recordSavedDraftLineage(
        db,
        workspaceId,
        draft,
        input.lineageOrigin,
      );
      return { outcome: result.outcome, draft };
    },

    async create(input) {
      const { data, error } = await db
        .from("chat_artifacts")
        .insert({
          workspace_id: workspaceId,
          chat_id: input.chatId,
          kind: input.kind,
          status: input.status,
          title: input.title,
          body: input.body,
          meta: input.meta,
          media_attachments: input.mediaAttachments,
          ...(input.planToPostOn !== undefined
            ? { plan_to_post_on: input.planToPostOn }
            : {}),
          ...(input.savedBy !== undefined ? { saved_by: input.savedBy } : {}),
        })
        .select(DRAFT_COLUMNS)
        .single();
      if (error) throw error;
      const draft = fromRow(data as unknown as DraftRow);
      await recordSavedDraftLineage(db, workspaceId, draft);
      return draft;
    },

    async createStandalone(input) {
      const { data, error } = await db.rpc("save_standalone_draft", {
        p_workspace_id: workspaceId,
        p_kind: input.kind,
        p_status: input.status,
        p_title: input.title,
        p_body: input.body,
        p_meta: input.meta,
        p_media_attachments: input.mediaAttachments,
        p_plan_to_post_on: input.planToPostOn ?? null,
      });
      if (error) throw error;
      const result = data as unknown as {
        outcome: "saved" | "deduped";
        draft: DraftRow;
      };
      if (!result.draft) throw new Error("save_standalone_draft returned no draft");
      return { outcome: result.outcome, draft: fromRow(result.draft) };
    },

    async mutate(id, patch, expectedVersion) {
      const { data, error } = await db
        .from("chat_artifacts")
        .update({
          ...toPatch(patch),
          lifecycle_version: expectedVersion + 1,
        })
        .eq("id", id)
        .eq("workspace_id", workspaceId)
        .eq("lifecycle_version", expectedVersion)
        // Excludes 'scheduled' on purpose (narrower than schedule()/remove()'s
        // SCHEDULABLE_SCHEDULE_STATUS_FILTER) — a generic field mutation must
        // not silently succeed on a queued draft; see MUTATABLE_SCHEDULE_STATUS_FILTER.
        .or(MUTATABLE_SCHEDULE_STATUS_FILTER)
        .select(DRAFT_COLUMNS)
        .maybeSingle();
      if (error) throw error;
      return data ? fromRow(data as unknown as DraftRow) : "stale";
    },

    async remove(id) {
      const { data: current, error: readError } = await db
        .from("chat_artifacts")
        .select("id, schedule_status")
        .eq("id", id)
        .eq("workspace_id", workspaceId)
        .maybeSingle();
      if (readError) throw readError;
      if (!current) return "not_found";
      if (current.schedule_status === "publishing" || current.schedule_status === "published") {
        return "conflict";
      }
      const { data, error } = await db
        .from("chat_artifacts")
        .delete()
        .eq("id", id)
        .eq("workspace_id", workspaceId)
        .or(SCHEDULABLE_SCHEDULE_STATUS_FILTER)
        .select("id");
      if (error) throw error;
      return data?.length ? "removed" : "conflict";
    },

    async schedule(id, patch) {
      let query = db
        .from("chat_artifacts")
        .update({
          schedule_status: "scheduled",
          scheduled_at: patch.scheduledAt,
          first_comment: patch.firstComment,
          plan_to_post_on: patch.planToPostOn,
          publish_error: null,
          publish_attempts: 0,
          zernio_post_id: null,
          published_at: null,
          posting_slot_id: patch.postingSlotId ?? null,
          posting_slot_occurrence_date: patch.postingSlotOccurrenceDate ?? null,
          lifecycle_version: patch.expectedVersion + 1,
        })
        .eq("id", id)
        .eq("workspace_id", workspaceId)
        .eq("lifecycle_version", patch.expectedVersion)
        .in("status", [...SCHEDULABLE_DRAFT_STATUSES])
        .or(SCHEDULABLE_SCHEDULE_STATUS_FILTER);
      if (patch.requireNoActiveQueueBooking) {
        query = query.or(
          "posting_slot_id.is.null,schedule_status.is.null,schedule_status.eq.failed",
        );
      }
      const { data, error } = await query
        .select(DRAFT_COLUMNS)
        .maybeSingle();
      // The occurrence unique index is the concurrency boundary: another
      // scheduler may have claimed this same slot after candidate lookup.
      if (error?.code === "23505" || error?.code === "40001") return "stale";
      if (error) throw error;
      return data ? fromRow(data as unknown as DraftRow) : "stale";
    },

    async cancelSchedule(id) {
      const { data, error } = await db
        .from("chat_artifacts")
        .update({
          schedule_status: null,
          scheduled_at: null,
          first_comment: null,
          posting_slot_id: null,
          posting_slot_occurrence_date: null,
        })
        .eq("id", id)
        .eq("workspace_id", workspaceId)
        .eq("schedule_status", "scheduled")
        .select(DRAFT_COLUMNS)
        .maybeSingle();
      if (error) throw error;
      return data ? fromRow(data as unknown as DraftRow) : "conflict";
    },
  };
}
