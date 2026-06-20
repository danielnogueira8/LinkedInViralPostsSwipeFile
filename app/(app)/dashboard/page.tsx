import { scopedSupabase } from "@/lib/supabase-scoped";
import { ChatWorkspace } from "./chat-workspace";

// The workspace home is now a Claude-Cowork-style chat where users run the
// content workflows (search the swipe file, mimic a viral post, create original
// content) via a GLM-5.1 tool-calling agent. The previous analytics home lives
// at /dashboard/insights (full analytics) and /dashboard/home-legacy (the old
// hero view); both remain reachable.
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

  return (
    <div className="-mt-2">
      <ChatWorkspace
        initialChats={chatList}
        initialChatId={activeId}
        initialMessages={messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          artifacts: (m.artifacts as never) ?? null,
        }))}
      />
    </div>
  );
}
