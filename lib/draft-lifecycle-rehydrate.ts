import { supabaseAdmin } from "@/lib/supabase";

type StoredArtifact = {
  kind?: string;
  meta?: Record<string, unknown> | null;
  [key: string]: unknown;
};

export type LiveDraftLifecycle = {
  id: string;
  scheduled_at: string | null;
  schedule_status: string | null;
  first_comment: string | null;
  plan_to_post_on: string | null;
};

export function spliceLiveLifecycleOntoArtifact(
  artifact: StoredArtifact,
  live: LiveDraftLifecycle | undefined,
): StoredArtifact {
  const meta = { ...(artifact.meta ?? {}) };
  if (!live) {
    delete meta.board_draft_id;
    delete meta.scheduled_at;
    delete meta.schedule_status;
    delete meta.first_comment;
    delete meta.plan_to_post_on;
    return { ...artifact, meta };
  }
  return {
    ...artifact,
    meta: {
      ...meta,
      board_draft_id: live.id,
      scheduled_at: live.scheduled_at,
      schedule_status: live.schedule_status,
      first_comment: live.first_comment,
      plan_to_post_on: live.plan_to_post_on,
    },
  };
}

type MessageWithArtifacts = { artifacts?: unknown };

function asArtifacts(value: unknown): StoredArtifact[] {
  return Array.isArray(value) ? (value as StoredArtifact[]) : [];
}

function boardDraftId(artifact: StoredArtifact): string | null {
  if (artifact.kind !== "post" && artifact.kind !== "hook") return null;
  const id = artifact.meta?.board_draft_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

// chat_messages.artifacts is a frozen transcript snapshot, while the linked
// chat_artifacts row owns the live board/scheduling lifecycle. Reconcile those
// fields whenever a chat is loaded so an unschedule, publish, failure, or delete
// performed from another surface cannot leave Cowork presenting stale actions.
// Prose and all non-lifecycle metadata remain transcript-owned. Best-effort:
// database failures preserve the stored snapshot instead of breaking the chat.
export async function rehydrateDraftLifecycle<T extends MessageWithArtifacts>(
  messages: T[],
  workspaceId: string,
): Promise<T[]> {
  try {
    const ids = new Set<string>();
    for (const message of messages) {
      for (const artifact of asArtifacts(message.artifacts)) {
        const id = boardDraftId(artifact);
        if (id) ids.add(id);
      }
    }
    if (ids.size === 0) return messages;

    const { data, error } = await supabaseAdmin()
      .from("chat_artifacts")
      .select(
        "id, scheduled_at, schedule_status, first_comment, plan_to_post_on",
      )
      .eq("workspace_id", workspaceId)
      .in("id", [...ids]);
    if (error || !data) return messages;

    const byId = new Map(
      data.map((row) => [row.id as string, row as LiveDraftLifecycle] as const),
    );
    return messages.map((message) => {
      const artifacts = asArtifacts(message.artifacts);
      if (!artifacts.some((artifact) => boardDraftId(artifact))) return message;
      return {
        ...message,
        artifacts: artifacts.map((artifact) => {
          const id = boardDraftId(artifact);
          return id
            ? spliceLiveLifecycleOntoArtifact(artifact, byId.get(id))
            : artifact;
        }),
      };
    });
  } catch {
    return messages;
  }
}
