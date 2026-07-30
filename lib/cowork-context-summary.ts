import type { AppliedLeadMagnet, Message } from "@/lib/chat-hydration";

// The source post a chat is modeling after — the minimal shape the context card
// needs (a subset of the client's ModelSource). "fetched from the swipein" is
// this: a swipe/bookmark/draft/template the chat is built on.
export type ContextSourcePost = {
  authorName: string | null;
  authorAvatar: string | null;
  postText: string;
  partial: boolean;
  postType: "regular" | "lead_magnet" | null;
  kind: "swipe" | "bookmark" | "draft" | "template";
  // Canonical LinkedIn URL of the original post — null for drafts/templates
  // (the user's own content, not a LinkedIn post) and for sources whose
  // underlying post row is gone. Drives the "view on LinkedIn" link icon.
  postUrl: string | null;
};

export type CreatorStyleContext = { name: string; creatorName: string | null };

// The transcript is the durable owner of modeled-post context. Returning the
// latest attachment lets every chat reconstruct its own source after a reload
// instead of depending on component memory.
export function latestPersistedModelSource(
  messages: Pick<Message, "modelSource">[],
): NonNullable<Message["modelSource"]> | null {
  let source: NonNullable<Message["modelSource"]> | null = null;
  for (const message of messages) {
    if (message.modelSource) source = message.modelSource;
  }
  return source;
}

// Everything that has shaped a chat, collapsed to one referenceable view. Built
// by aggregating the per-message context the transcript already carries (each
// user Message stamps the skills / format / creator style / lead magnet / files
// it was sent with) plus the active model source. No new data model — this is a
// pure fold over what hydrate() already reconstructed.
export type ChatContextSummary = {
  sourcePost: ContextSourcePost | null;
  skills: string[];
  postFormats: string[];
  creatorStyle: CreatorStyleContext | null;
  leadMagnet: AppliedLeadMagnet | null;
  files: string[];
};

// True when the summary holds nothing worth showing — the card should not render.
export function isContextSummaryEmpty(summary: ChatContextSummary): boolean {
  return (
    summary.sourcePost === null &&
    summary.skills.length === 0 &&
    summary.postFormats.length === 0 &&
    summary.creatorStyle === null &&
    summary.leadMagnet === null &&
    summary.files.length === 0
  );
}

// Push a value into an accumulator only once (first occurrence wins, order kept).
function pushUnique(into: string[], seen: Set<string>, value: string | undefined | null) {
  const trimmed = value?.trim();
  if (!trimmed || seen.has(trimmed)) return;
  seen.add(trimmed);
  into.push(trimmed);
}

// Aggregate a chat's context from its messages + active source post.
//
// Rules:
//   • Multi-valued context (skills, post formats, files) is UNIONed across every
//     message, de-duplicated, first-seen order preserved — a chat that applied a
//     skill on turn 1 still shows it after ten more turns.
//   • Single-valued context (creator style, lead magnet) takes the MOST RECENT
//     non-empty value: the chat's current style/giveaway, since a later turn can
//     switch it. Iterating oldest→newest and overwriting yields "last wins".
//   • The source post comes from the live handoff while it is pending, then from
//     the owning user message once the server has persisted and rehydrated it.
//     The live handoff wins during the brief overlap around a send.
export function summarizeChatContext(input: {
  messages: Pick<
    Message,
    | "skills"
    | "postFormat"
    | "creatorStyle"
    | "leadMagnet"
    | "files"
    | "modelSource"
  >[];
  sourcePost?: ContextSourcePost | null;
}): ChatContextSummary {
  const skills: string[] = [];
  const skillsSeen = new Set<string>();
  const postFormats: string[] = [];
  const formatsSeen = new Set<string>();
  const files: string[] = [];
  const filesSeen = new Set<string>();
  let creatorStyle: CreatorStyleContext | null = null;
  let leadMagnet: AppliedLeadMagnet | null = null;

  for (const message of input.messages) {
    for (const skill of message.skills ?? []) pushUnique(skills, skillsSeen, skill);
    pushUnique(postFormats, formatsSeen, message.postFormat);
    for (const file of message.files ?? []) pushUnique(files, filesSeen, file);
    // Last non-empty wins (oldest→newest overwrite).
    if (message.creatorStyle) creatorStyle = message.creatorStyle;
    if (message.leadMagnet) leadMagnet = message.leadMagnet;
  }

  const persistedModelSource = latestPersistedModelSource(input.messages);
  const persistedSourcePost: ContextSourcePost | null =
    persistedModelSource?.state === "available"
      ? {
          authorName: persistedModelSource.authorName,
          authorAvatar: persistedModelSource.authorAvatar,
          postText: persistedModelSource.postText,
          partial: persistedModelSource.partial,
          postType: persistedModelSource.postType,
          kind: persistedModelSource.kind,
          postUrl: persistedModelSource.postUrl,
        }
      : null;

  return {
    sourcePost: input.sourcePost ?? persistedSourcePost,
    skills,
    postFormats,
    creatorStyle,
    leadMagnet,
    files,
  };
}
