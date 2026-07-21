import { Suspense } from "react";
import { currentUser } from "@clerk/nextjs/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { rehydrateCites } from "@/lib/cite-resolve";
import { rehydrateDraftLifecycle } from "@/lib/draft-lifecycle-rehydrate";
import type { CustomSkill } from "@/lib/custom-skills";
import { CHAT_MODEL } from "@/lib/openrouter";
import { contentFormatForModel } from "@/lib/markdown/mode";
import { ChatWorkspace, type Author, type CoworkNextAction } from "./chat-workspace";
import {
  creatorBaselinesFromRows,
  outlierMetricLabel,
  type MetricBaseline,
} from "@/lib/outlier-metric";

// The workspace home is now a Claude-Cowork-style chat where users run the
// content workflows (search the swipe file, mimic a viral post, create original
// content) via a GLM-5.1 tool-calling agent. The old hero view still lives at
// /dashboard/home-legacy.
//
// Server component: load the chat list + the most recent chat's transcript so
// the workspace hydrates without a client round-trip on first paint.

export const dynamic = "force-dynamic";

const FRESH_INSPIRATION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

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
  content_format: "legacy" | "plain" | "markdown" | null;
  tool_calls: unknown;
  artifacts: unknown;
  created_at: string;
};

function requestFreshWindow() {
  const now = Date.now();
  return new Date(now - FRESH_INSPIRATION_WINDOW_MS).toISOString();
}

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

  const trackedAccountsPromise = sb.workspaceAccountsSelect("account_id");
  const pendingReviewPromise = sb.raw
    .from("chat_artifacts")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", sb.workspaceId)
    .eq("status", "pending_review");
  const readyUnscheduledPromise = sb.raw
    .from("chat_artifacts")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", sb.workspaceId)
    .eq("status", "ready")
    .is("scheduled_at", null);
  const userPromise = currentUser();

  const [
    { data: chats },
    { data: voice },
    { data: skills },
    { data: trackedAccounts },
    { count: pendingReviewCount },
    { count: readyUnscheduledCount },
    user,
    { chat: wantChat, model: modelSourceId },
  ] =
    await Promise.all([
      chatsPromise,
      voicePromise,
      skillsPromise,
      trackedAccountsPromise,
      pendingReviewPromise,
      readyUnscheduledPromise,
      userPromise,
      searchParams,
    ]);

  const initialCustomSkills = (skills ?? []) as CustomSkill[];
  const trackedAccountIds = ((trackedAccounts ?? []) as Array<{ account_id: string }>).map(
    (row) => row.account_id,
  );
  const freshSince = requestFreshWindow();
  const { count: freshInspirationCount } =
    trackedAccountIds.length > 0
      ? await sb.raw
          .from("posts")
          .select("id", { count: "exact", head: true })
          .in("account_id", trackedAccountIds)
          .gte("posted_at", freshSince)
      : { count: 0 };

  // Breakout radar (Phase E4): the hottest fresh regular post across tracked
  // creators in the last 48h. Already-scraped data, no LLM. Regular posts only
  // (same reason as the scanner: lead-magnet modeling needs a resource).
  const { data: breakoutPost } =
    trackedAccountIds.length > 0
      ? await sb.raw
          .from("posts")
          .select(
            "id, account_id, viral_score, reactions, comments, posted_at, accounts!inner(name, archived_at)",
          )
          .in("account_id", trackedAccountIds)
          .eq("is_viral", true)
          .or("post_type.is.null,post_type.eq.regular")
          .is("accounts.archived_at", null)
          .gte(
            "posted_at",
            new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
          )
          .order("viral_score", { ascending: false })
          .limit(1)
          .maybeSingle()
      : { data: null };
  // The creator's 90-day norm, so the chip can say WHICH metric broke out
  // ("2.3k likes" / "140 comments" / "1.5× their norm").
  let breakoutBaseline: MetricBaseline | null = null;
  if (breakoutPost?.account_id) {
    const { data: baselineRows } = await sb.raw
      .from("posts")
      .select("account_id, reactions, comments")
      .eq("account_id", breakoutPost.account_id)
      .gte(
        "posted_at",
        new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
      )
      .limit(300);
    breakoutBaseline =
      creatorBaselinesFromRows(
        (baselineRows ?? []) as Array<{
          account_id: string;
          reactions: number | null;
          comments: number | null;
        }>,
      ).get(breakoutPost.account_id as string) ?? null;
  }
  const breakout = breakoutPost
    ? {
        postId: breakoutPost.id as string,
        authorName:
          ((Array.isArray(breakoutPost.accounts)
            ? breakoutPost.accounts[0]
            : breakoutPost.accounts)?.name as string | null) ?? "A creator",
        metricLabel: outlierMetricLabel(
          {
            reactions: (breakoutPost.reactions as number | null) ?? null,
            comments: (breakoutPost.comments as number | null) ?? null,
          },
          breakoutBaseline,
        ),
        postedAt: (breakoutPost.posted_at as string | null) ?? null,
      }
    : null;

  const voiceReady = Boolean(voice?.status === "ready" && voice?.profile);
  const initialNextAction = getCoworkNextAction({
    hasTrackedCreators: trackedAccountIds.length > 0,
    voiceReady,
    freshInspirationCount: freshInspirationCount ?? 0,
    breakout,
    pendingReviewCount: pendingReviewCount ?? 0,
    readyUnscheduledCount: readyUnscheduledCount ?? 0,
  });

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
      .select("id, role, content, content_format, tool_calls, artifacts, created_at")
      .eq("chat_id", activeId)
      .eq("workspace_id", sb.workspaceId)
      .order("created_at", { ascending: true });
    messages = (msgs ?? []) as MessageRow[];
    // Re-resolve cited source-post cards (only the postId is persisted).
    messages = await rehydrateCites(messages, sb.workspaceId);
    messages = await rehydrateDraftLifecycle(messages, sb.workspaceId);
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
    // Clerk's photo as a durable backup: voice.avatar_url is a LinkedIn CDN URL
    // that expires, so when it 404s the draft card falls back to this rather than
    // straight to initials. (When avatarUrl already IS the Clerk URL, AvatarImg
    // de-dupes so it's a harmless no-op.)
    fallbackAvatarUrl: user?.imageUrl || null,
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
          initialVoiceReady={voiceReady}
          initialNextAction={initialNextAction}
          writerContentFormat={contentFormatForModel(CHAT_MODEL)}
          initialMessages={messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            content_format:
              m.content_format === "markdown" || m.content_format === "plain"
                ? m.content_format
                : null,
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

export type CoworkBreakout = {
  postId: string;
  authorName: string;
  /** "2.3k likes" / "140 comments" / "1.5× their norm" — the winning metric. */
  metricLabel: string;
  postedAt: string | null;
};

export function getCoworkNextAction({
  hasTrackedCreators,
  voiceReady,
  freshInspirationCount,
  breakout,
  pendingReviewCount,
  readyUnscheduledCount,
}: {
  hasTrackedCreators: boolean;
  voiceReady: boolean;
  freshInspirationCount: number;
  breakout?: CoworkBreakout | null;
  pendingReviewCount: number;
  readyUnscheduledCount: number;
}): CoworkNextAction {
  if (!hasTrackedCreators) {
    return {
      kind: "track_creators",
      title: "Track your first creators",
      description: "Add source accounts so Cowork has strong posts to learn from.",
      cta: "Track creators",
      href: "/dashboard/accounts",
    };
  }
  if (!voiceReady) {
    return {
      kind: "voice",
      title: "Set up your voice",
      description: "Cowork can write closer to you once your voice profile is ready.",
      cta: "Set up voice",
      href: "/dashboard/voice",
    };
  }
  if (freshInspirationCount === 0) {
    return {
      kind: "inspiration",
      title: "Fill your inspiration library",
      description: "Browse the Swipe File after your tracked creators are scraped.",
      cta: "Browse inspiration",
      href: "/dashboard/swipe",
    };
  }
  // Breakout radar: time-sensitive, so it outranks the standing review/schedule
  // nudges — a 3-hour-old outlier is gone tomorrow, the review queue is not.
  if (breakout) {
    const ageHours = breakout.postedAt
      ? Math.max(
          1,
          Math.round(
            (Date.now() - Date.parse(breakout.postedAt)) / (1000 * 60 * 60),
          ),
        )
      : null;
    return {
      kind: "breakout",
      title: `${breakout.authorName} — ${breakout.metricLabel}${
        ageHours ? ` · ${ageHours}h ago` : ""
      } — model it while it's hot`,
      description: "The freshest outlier from your tracked creators.",
      cta: "Model it",
      href: "/dashboard",
      breakoutPostId: breakout.postId,
    };
  }
  if (pendingReviewCount > 0) {
    return {
      kind: "review",
      title: "Review pending drafts",
      description: `${pendingReviewCount} batch draft${pendingReviewCount === 1 ? "" : "s"} waiting for approval.`,
      cta: "Review drafts",
      href: "/dashboard/posts",
    };
  }
  if (readyUnscheduledCount > 0) {
    return {
      kind: "schedule",
      title: "Schedule ready posts",
      description: `${readyUnscheduledCount} ready post${readyUnscheduledCount === 1 ? "" : "s"} waiting for a publish time.`,
      cta: "Schedule posts",
      href: "/dashboard/posts",
    };
  }
  return {
    kind: "batch",
    title: "Generate this week's batch",
    description: "Create 5 regular posts and 2 lead magnet posts from your best sources.",
    cta: "Generate batch",
    href: "/dashboard",
  };
}
