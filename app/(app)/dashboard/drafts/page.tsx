import { currentUser } from "@clerk/nextjs/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { DraftsList } from "./drafts-list";
import type { Author } from "../chat-workspace";

// Saved drafts — the posts the user kept via "Save draft" in the chat (rows in
// chat_artifacts). Rendered as LinkedIn-style post previews, copyable and
// deletable. Separate from the chat itself so drafts persist and are findable
// after the conversation scrolls away.

export const dynamic = "force-dynamic";

type DraftRow = {
  id: string;
  title: string | null;
  body: string;
  meta: unknown;
  chat_id: string | null;
  created_at: string;
};

export default async function DraftsPage() {
  const sb = await scopedSupabase();

  const { data: drafts } = await sb.raw
    .from("chat_artifacts")
    .select("id, title, body, meta, chat_id, created_at")
    .eq("workspace_id", sb.workspaceId)
    .order("created_at", { ascending: false })
    .limit(200);

  // Same author identity as the chat draft cards (voice profile first, Clerk
  // fallback) so the previews look consistent across the two surfaces.
  const { data: voice } = await sb.raw
    .from("voice_profiles")
    .select("display_name, avatar_url, headline")
    .eq("workspace_id", sb.workspaceId)
    .maybeSingle();
  const user = await currentUser();
  const clerkName =
    [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
    user?.username ||
    "You";
  const author: Author = {
    name: (voice?.display_name as string | null) || clerkName,
    avatarUrl: (voice?.avatar_url as string | null) || user?.imageUrl || null,
    headline: (voice?.headline as string | null) || null,
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Saved drafts</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Posts you saved from chat. Copy them to LinkedIn or remove the ones you
          don&apos;t need.
        </p>
      </div>
      <DraftsList
        author={author}
        initialDrafts={(drafts ?? []).map((d) => {
          const row = d as DraftRow;
          return {
            id: row.id,
            title: row.title,
            body: row.body,
            createdAt: row.created_at,
          };
        })}
      />
    </div>
  );
}
