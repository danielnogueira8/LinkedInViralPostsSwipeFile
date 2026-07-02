import { scopedSupabase } from "@/lib/supabase-scoped";
import { DraftsList, type DraftStatus } from "./drafts-list";
import { GenerateBatchButton } from "./generate-batch-button";

// Saved posts — the drafts the user kept via "Save draft" in the chat, plus any
// authored on the board (rows in chat_artifacts). Rendered as a Notion-style
// pipeline board: each card is the post's name; clicking it opens a detail
// drawer to edit the body, status, due date, and name.

export const dynamic = "force-dynamic";

type DraftRow = {
  id: string;
  title: string | null;
  body: string;
  meta: unknown;
  kind: string;
  status: string;
  plan_to_post_on: string | null;
  chat_id: string | null;
  created_at: string;
};

export default async function DraftsPage() {
  const sb = await scopedSupabase();

  const { data: drafts } = await sb.raw
    .from("chat_artifacts")
    .select(
      "id, title, body, meta, kind, status, plan_to_post_on, chat_id, created_at",
    )
    .eq("workspace_id", sb.workspaceId)
    .order("created_at", { ascending: false })
    .limit(200);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Posts</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Your content pipeline. Drag a card to move it from idea to posted, or
            open it to edit, schedule, and copy.
          </p>
        </div>
        {/* On-demand weekly batch: finds this week's top posts, drafts them in
            your voice, and drops them here as review-ready drafts. */}
        <GenerateBatchButton />
      </div>
      <DraftsList
        initialDrafts={(drafts ?? []).map((d) => {
          const row = d as DraftRow;
          return {
            id: row.id,
            title: row.title,
            body: row.body,
            kind:
              row.kind === "hook" || row.kind === "lead_magnet"
                ? row.kind
                : "post",
            status: normalizeStatus(row.status),
            planToPostOn: row.plan_to_post_on,
            chatId: row.chat_id,
            createdAt: row.created_at,
            // Surface the batch source link (meta.source_url) so the card can show
            // "Adapted from ↗". Only weekly-batch drafts carry it.
            sourceUrl: sourceUrlFromMeta(row.meta),
          };
        })}
      />
    </div>
  );
}

// Pull the weekly-batch source URL out of a draft's meta jsonb, when present.
// Only a batch draft has meta.source === 'weekly_batch' with a source_url;
// everything else returns null (no "adapted from" link). Exported for tests.
export function sourceUrlFromMeta(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as { source?: unknown; source_url?: unknown };
  if (m.source !== "weekly_batch") return null;
  return typeof m.source_url === "string" && m.source_url ? m.source_url : null;
}

// Guard an untrusted/legacy status value to a known pipeline stage.
function normalizeStatus(s: string | null | undefined): DraftStatus {
  return s === "idea" || s === "drafting" || s === "ready" || s === "posted"
    ? s
    : "drafting";
}
