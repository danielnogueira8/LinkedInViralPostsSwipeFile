import { resolveModelSourcePostType, type PostType } from "@/lib/post-type";
import { supabaseAdmin } from "@/lib/supabase";
import { trackedAccountIds } from "@/lib/supabase-scoped";

export type ModelSourceAttachment = {
  id: string;
  kind: "swipe" | "bookmark" | "draft" | "template";
  state: "available" | "unavailable";
  authorName: string | null;
  authorAvatar: string | null;
  postText: string;
  partial: boolean;
  postType: PostType | null;
  // Canonical LinkedIn URL of the original post — null for drafts/templates
  // (no LinkedIn origin) and when the underlying post row is gone.
  postUrl: string | null;
};

type SourceMessage = {
  role?: string;
  model_source_id?: string | null;
  model_source_attachment?: ModelSourceAttachment | null;
};

type SourceRow = {
  id: string;
  source: string;
  source_post_id: string | null;
  post_text: string;
  author_name: string | null;
  author_avatar: string | null;
  partial: boolean | null;
  post_type: string | null;
};

const NO_ROWS_SENTINEL = "00000000-0000-0000-0000-000000000000";

function unavailableAttachment(id: string): ModelSourceAttachment {
  return {
    id,
    // The unavailable rendering is intentionally source-neutral; this fallback
    // only needs a valid presentation shape when an old transient row is gone.
    kind: "swipe",
    state: "unavailable",
    authorName: null,
    authorAvatar: null,
    postText: "",
    partial: false,
    postType: null,
    postUrl: null,
  };
}

function withUnavailableAttachments<T extends SourceMessage>(messages: T[]): T[] {
  return messages.map((message) =>
    message.role === "user" && typeof message.model_source_id === "string"
      ? {
          ...message,
          model_source_attachment:
            message.model_source_attachment ?? unavailableAttachment(message.model_source_id),
        }
      : message,
  );
}

/** Rehydrate modeled Swipefile/Bookmark attachments with current scoped data. */
export async function rehydrateModelSourceAttachments<T extends SourceMessage>(
  messages: T[],
  workspaceId: string,
): Promise<T[]> {
  try {
    const ids = [...new Set(messages.flatMap((message) =>
      message.role === "user" && typeof message.model_source_id === "string"
        ? [message.model_source_id]
        : [],
    ))];
    if (ids.length === 0) return messages;

    const sb = supabaseAdmin();
    const { data: rows, error } = await sb
      .from("chat_modeling_sources")
      .select("id, source, source_post_id, post_text, author_name, author_avatar, partial, post_type")
      .eq("workspace_id", workspaceId)
      .in("id", ids);
    if (error || !rows) return withUnavailableAttachments(messages);
    const allSources = rows as SourceRow[];
    // Swipe/bookmark sources point at a row that can change or disappear, so
    // they get re-resolved below. Templates and drafts have no live external
    // row to re-read — the complete body was captured into post_text when the
    // source was attached — so they rehydrate straight from the stashed text.
    // Dropping them here is what made a template chip come back as "Source post
    // no longer available", taking the template body out of chat context.
    const sources = allSources.filter(
      (source) =>
        (source.source === "swipe" || source.source === "bookmark") &&
        Boolean(source.source_post_id),
    );
    const selfContained = allSources.filter(
      (source) => source.source === "template" || source.source === "draft",
    );

    const swipeIds = sources.filter((source) => source.source === "swipe").map((source) => source.source_post_id!);
    const bookmarkIds = sources.filter((source) => source.source === "bookmark").map((source) => source.source_post_id!);
    // Only needed to scope the swipe read; a template/draft-only conversation
    // shouldn't pay for this lookup.
    const accountIds = swipeIds.length ? await trackedAccountIds(workspaceId) : [];
    const [swipes, bookmarks] = await Promise.all([
      swipeIds.length
        ? sb.from("posts").select("id, text, post_type, post_url, accounts!inner(name, profile_pic_url)").in("id", swipeIds).in("account_id", accountIds.length ? accountIds : [NO_ROWS_SENTINEL])
        : Promise.resolve({ data: [], error: null }),
      bookmarkIds.length
        ? sb.from("saved_posts").select("id, text, text_snippet, author_name, profile_pic_url, post_type, post_url").eq("workspace_id", workspaceId).in("id", bookmarkIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (swipes.error || bookmarks.error) return messages;

    const swipeById = new Map((swipes.data ?? []).map((row) => [row.id as string, row]));
    const bookmarkById = new Map((bookmarks.data ?? []).map((row) => [row.id as string, row]));
    const attachments = new Map<string, ModelSourceAttachment>();
    // Templates and drafts: the stashed post_text IS the source of truth, so
    // they stay available for the life of the conversation. A template has no
    // author (it isn't a person's post) and no LinkedIn URL.
    for (const source of selfContained) {
      const kind = source.source as "template" | "draft";
      attachments.set(source.id, {
        id: source.id,
        kind,
        state: source.post_text?.trim() ? "available" : "unavailable",
        authorName: kind === "template" ? null : source.author_name,
        authorAvatar: kind === "template" ? null : source.author_avatar,
        postText: source.post_text ?? "",
        partial: Boolean(source.partial),
        postType: resolveModelSourcePostType(source.post_type, source.post_text ?? ""),
        postUrl: null,
      });
    }
    for (const source of sources) {
      const current = source.source === "swipe"
        ? swipeById.get(source.source_post_id!)
        : bookmarkById.get(source.source_post_id!);
      const kind = source.source as "swipe" | "bookmark";
      if (!current) {
        attachments.set(source.id, { id: source.id, kind, state: "unavailable", authorName: null, authorAvatar: null, postText: "", partial: false, postType: null, postUrl: null });
        continue;
      }
      const row = current as Record<string, unknown>;
      const accounts = row.accounts as { name?: string | null; profile_pic_url?: string | null }[] | { name?: string | null; profile_pic_url?: string | null } | null;
      const account = Array.isArray(accounts) ? accounts[0] : accounts;
      const postText = source.source === "swipe"
        ? (row.text as string | null) ?? source.post_text
        : (row.text as string | null) ?? (row.text_snippet as string | null) ?? source.post_text;
      attachments.set(source.id, {
        id: source.id,
        kind,
        state: "available",
        authorName: source.source === "swipe" ? account?.name ?? source.author_name : (row.author_name as string | null) ?? source.author_name,
        authorAvatar: source.source === "swipe" ? account?.profile_pic_url ?? source.author_avatar : (row.profile_pic_url as string | null) ?? source.author_avatar,
        postText,
        partial: Boolean(source.partial),
        postType: resolveModelSourcePostType(row.post_type, postText),
        postUrl: (row.post_url as string | null) ?? null,
      });
    }
    return messages.map((message) => {
      const attachment =
        message.role === "user" && typeof message.model_source_id === "string"
          ? attachments.get(message.model_source_id)
          : undefined;
      return message.role === "user" && typeof message.model_source_id === "string"
        ? {
            ...message,
            model_source_attachment: attachment ?? unavailableAttachment(message.model_source_id),
          }
        : message;
    });
  } catch {
    // A source lookup must never prevent the conversation itself from loading.
    return withUnavailableAttachments(messages);
  }
}
