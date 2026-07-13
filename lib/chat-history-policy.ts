export type ChatGroupKey = "today" | "yesterday" | "previous7" | "older";

export const CHAT_GROUP_LABEL: Record<ChatGroupKey, string> = {
  today: "Today",
  yesterday: "Yesterday",
  previous7: "Previous 7 days",
  older: "Older",
};

// Filter chats by a search query against the title (case-insensitive, trimmed).
// Empty query returns everything.
export function filterChats<T extends { title: string }>(
  chats: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return chats;
  return chats.filter((c) => c.title.toLowerCase().includes(q));
}

// Which date bucket a chat falls into, by its updated_at relative to `now`.
// Buckets are calendar-day based (local time): a chat from 11pm yesterday is
// "Yesterday", not "23 hours ago".
export function chatGroupFor(updatedAt: string, now: Date): ChatGroupKey {
  const d = new Date(updatedAt);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msPerDay = 86_400_000;
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((startOfToday.getTime() - dayStart.getTime()) / msPerDay);
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays <= 7) return "previous7";
  return "older";
}

// Group chats into ordered date sections, preserving the input order within
// each section (callers pass already-recency-sorted chats). Empty sections are
// omitted. `now` is injected so the grouping is deterministic + testable.
export function groupChatsByDate<T extends { updated_at: string }>(
  chats: T[],
  now: Date,
): { key: ChatGroupKey; chats: T[] }[] {
  const order: ChatGroupKey[] = ["today", "yesterday", "previous7", "older"];
  const buckets: Record<ChatGroupKey, T[]> = {
    today: [],
    yesterday: [],
    previous7: [],
    older: [],
  };
  for (const c of chats) buckets[chatGroupFor(c.updated_at, now)].push(c);
  return order
    .map((key) => ({ key, chats: buckets[key] }))
    .filter((g) => g.chats.length > 0);
}
