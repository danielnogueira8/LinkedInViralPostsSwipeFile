import { Suspense } from "react";
import { currentUser } from "@clerk/nextjs/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { rehydrateCites } from "@/lib/cite-resolve";
import type { CustomSkill } from "@/lib/custom-skills";
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
  tool_calls: unknown;
  artifacts: unknown;
  created_at: string;
};

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ chat?: string; model?: string }>;
}) {
  const sb = await scopedSupabase();

  const chatsPromise = sb.raw
    .from("chats")
    .select("id, title, created_at, updated_at")
    .eq("workspace_id", sb.workspaceId)
    .is("archived_at", null)
    .order("updated_at", { ascending: false })
    .limit(100);

  const voicePromise = sb.raw
    .from("voice_profiles")
    .select("display_name, avatar_url, headline, status, profile")
    .eq("workspace_id", sb.workspaceId)
    .maybeSingle();

  // The workspace's custom skills, server-fetched so the composer's ⚡ button
  // renders on the FIRST paint. Previously ChatWorkspace loaded these via a
  // client mount fetch, so the button popped in a few ms after the other picker
  // icons (visible on nav-back to an already-open chat). Seeding it here removes
  // that flicker. Matches /api/skills's columns + ordering.
  const skillsPromise = sb.raw
    .from("custom_skills")
    .select("id, workspace_id, name, description, body, created_at, updated_at")
    .eq("workspace_id", sb.workspaceId)
    .order("created_at", { ascending: false });

  const userPromise = currentUser();

  const [
    { data: chats },
    { data: voice },
    { data: skills },
    user,
    { chat: wantChat, model: modelSourceId },
  ] =
    await Promise.all([
      chatsPromise,
      voicePromise,
      skillsPromise,
      userPromise,
      searchParams,
    ]);

  const initialCustomSkills = (skills ?? []) as CustomSkill[];

  const chatList = (chats ?? []) as ChatRow[];
  // Open the chat named in ?chat= when it belongs to this workspace (the batch
  // navigates here after firing); otherwise the most recent chat. Model-source
  // handoffs intentionally start blank so Swipe File / Bookmark modeling never
  // flashes or reuses the last open conversation before the fresh chat is created.
  const activeId = modelSourceId
    ? null
    : ((wantChat && chatList.some((c) => c.id === wantChat) ? wantChat : null) ??
      chatList[0]?.id ??
      null);

  let messages: MessageRow[] = [];
  if (activeId) {
    const { data: msgs } = await sb.raw
      .from("chat_messages")
      // tool_calls included so hydrate() can reconstruct an AskCard from a
      // persisted ask_user tool call — survives a hard refresh (bug 1).
      .select("id, role, content, tool_calls, artifacts, created_at")
      .eq("chat_id", activeId)
      .eq("workspace_id", sb.workspaceId)
      .order("created_at", { ascending: true });
    messages = (msgs ?? []) as MessageRow[];
    // Re-resolve cited source-post cards (only the postId is persisted).
    messages = await rehydrateCites(messages, sb.workspaceId);
  }

  // Author identity for the LinkedIn-style draft preview. Prefer the voice
  // profile's LinkedIn identity (the name/avatar/headline the drafts are
  // actually for); fall back to the Clerk account.
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
    <>
      {/* Suspense boundary: ChatWorkspace reads useSearchParams() (?model=…). */}
      <Suspense fallback={null}>
        <ChatWorkspace
          author={author}
          initialChats={chatList}
          initialChatId={activeId}
          initialCustomSkills={initialCustomSkills}
          initialVoiceReady={Boolean(voice?.status === "ready" && voice?.profile)}
          initialMessages={messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            // tool_calls MUST ride through to hydrate() — it reconstructs the
            // ask_user checkboxes + the /skill bubble badge from the persisted
            // synthetic tool calls. We SELECT it above, but the map used to
            // drop it here, so on a FIRST page load (this path) those vanished
            // and only reappeared after a chat-switch (the GET route kept it).
            tool_calls: (m.tool_calls as never) ?? null,
            artifacts: (m.artifacts as never) ?? null,
          }))}
        />
      </Suspense>
    </>
  );
}
