import type { ContentFormat } from "@/lib/markdown/mode";
import type { PostMediaAttachment } from "@/lib/post-media";
import type { DraftKind, DraftStatus } from "@/lib/draft-lifecycle";

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

export type DraftScheduleCommand = {
  scheduledAt: string;
  planToPostOn: string;
  firstComment: string | null;
};

export type ScheduledDraftState = {
  scheduledAt: string;
  scheduleStatus: "scheduled";
  planToPostOn: string;
  firstComment: string | null;
};

export type UnscheduledDraftState = {
  scheduledAt: null;
  scheduleStatus: null;
  firstComment: null;
};

type DraftApiRecord = {
  id: string;
  [key: string]: unknown;
};

type ApiEnvelope = {
  ok?: boolean;
  error?: string;
  draft?: DraftApiRecord;
  scheduledAt?: string | null;
  scheduleStatus?: string | null;
  planToPostOn?: string | null;
  firstComment?: string | null;
};

async function readDraftOperationResponse(
  response: Response,
  fallbackError: string,
): Promise<ApiEnvelope> {
  const text = await response.text();
  let value: ApiEnvelope | null = null;
  try {
    value = text ? (JSON.parse(text) as ApiEnvelope) : null;
  } catch {
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    throw new Error("Invalid response from server");
  }
  if (!response.ok || !value?.ok) {
    throw new Error(value?.error || fallbackError);
  }
  return value;
}

export function createDraftOperationsClient(
  fetcher: FetchDraftOperation = fetch,
) {
  return {
    async update(
      draftId: string,
      command: DraftUpdateCommand,
    ): Promise<DraftApiRecord> {
      const response = await fetcher(`/api/drafts/${draftId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
      const value = await readDraftOperationResponse(
        response,
        "Failed to update draft",
      );
      if (!value.draft) throw new Error("Draft response was missing its Draft.");
      return value.draft;
    },

    async schedule(
      draftId: string,
      command: DraftScheduleCommand,
    ): Promise<ScheduledDraftState> {
      const response = await fetcher(`/api/drafts/${draftId}/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
      const value = await readDraftOperationResponse(
        response,
        "Couldn't schedule.",
      );
      return {
        scheduledAt: value.scheduledAt ?? command.scheduledAt,
        scheduleStatus: "scheduled",
        planToPostOn: value.planToPostOn ?? command.planToPostOn,
        firstComment: value.firstComment ?? command.firstComment,
      };
    },

    async unschedule(draftId: string): Promise<UnscheduledDraftState> {
      const response = await fetcher(`/api/drafts/${draftId}/schedule`, {
        method: "DELETE",
      });
      await readDraftOperationResponse(response, "Couldn't unschedule.");
      return {
        scheduledAt: null,
        scheduleStatus: null,
        firstComment: null,
      };
    },
  };
}

export const draftOperations = createDraftOperationsClient();
