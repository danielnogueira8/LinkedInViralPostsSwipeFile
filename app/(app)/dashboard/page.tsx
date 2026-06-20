import { Suspense } from "react";
import { currentUser } from "@clerk/nextjs/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { ChatWorkspace, type Author } from "./chat-workspace";

// The workspace home is now a Claude-Cowork-style chat where users run the
// content workflows (search the swipe file, mimic a viral post, create original
// content) via a GLM-5.1 tool-calling agent. The old hero view still lives at
// /dashboard/home-legacy.
//
// Server component: load the chat list + the most recent chat's transcript so
// the workspace hydrates without a client round-trip on first paint.

export const dynamic = "force-dynamic";

type ChatRow = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  artifacts: unknown;
  created_at: string;
};

export default async function ChatPage() {
  const sb = await scopedSupabase();

  const { data: chats } = await sb.raw
    .from("chats")
    .select("id, title, created_at, updated_at")
    .eq("workspace_id", sb.workspaceId)
    .is("archived_at", null)
    .order("updated_at", { ascending: false })
    .limit(100);

  const chatList = (chats ?? []) as ChatRow[];
  const activeId = chatList[0]?.id ?? null;

  let messages: MessageRow[] = [];
  if (activeId) {
    const { data: msgs } = await sb.raw
      .from("chat_messages")
      .select("id, role, content, artifacts, created_at")
      .eq("chat_id", activeId)
      .eq("workspace_id", sb.workspaceId)
      .order("created_at", { ascending: true });
    messages = (msgs ?? []) as MessageRow[];
  }

  // Author identity for the LinkedIn-style draft preview. Prefer the voice
  // profile's LinkedIn identity (the name/avatar/headline the drafts are
  // actually for); fall back to the Clerk account.
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
    <div className="-mt-2">
      {/* Suspense boundary: ChatWorkspace reads useSearchParams() (?model=…). */}
      <Suspense fallback={null}>
        <ChatWorkspace
          author={author}
          initialChats={chatList}
          initialChatId={activeId}
          initialMessages={messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            artifacts: (m.artifacts as never) ?? null,
          }))}
        />
      </Suspense>
    </div>
  );
}
