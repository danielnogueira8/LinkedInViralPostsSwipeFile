const NEW_CHAT_SLOT = "__new__";

export function modelHandoffDestination(chatId: string): string {
  return `/dashboard?chat=${encodeURIComponent(chatId)}`;
}

export function modelSourceBelongsToChat(
  activeChatId: string | null,
  ownerChatId: string | null,
): boolean {
  return !!activeChatId && activeChatId === ownerChatId;
}

export function composerContextBelongsToChat(
  activeChatId: string | null,
  ownerChatId: string | null,
): boolean {
  return activeChatId === ownerChatId;
}

export function updateChatScopedList<T>(
  current: Map<string, T[]>,
  chatId: string | null,
  update: T[] | ((items: T[]) => T[]),
): Map<string, T[]> {
  const key = chatId ?? NEW_CHAT_SLOT;
  const previous = current.get(key) ?? [];
  const nextItems = typeof update === "function" ? update(previous) : update;
  const next = new Map(current);
  if (nextItems.length > 0) next.set(key, nextItems);
  else next.delete(key);
  return next;
}

export function readChatScopedList<T>(
  current: Map<string, T[]>,
  chatId: string | null,
): T[] {
  return current.get(chatId ?? NEW_CHAT_SLOT) ?? [];
}

export function prependChatIfMissing<T extends { id: string }>(
  chats: T[],
  incoming: T,
): T[] {
  return chats.some((chat) => chat.id === incoming.id)
    ? chats
    : [incoming, ...chats];
}

export async function chatIdAfterPendingNewSession(
  pendingNewSession: Promise<unknown> | null,
  activeChatId: () => string | null,
): Promise<string | null> {
  if (pendingNewSession) {
    try {
      await pendingNewSession;
    } catch {
      // A failed eager create falls back to send's normal lazy-create path.
    }
  }
  return activeChatId();
}

export function shouldSyncSelectedChat(
  selectedChatId: string | null,
  activeChatId: string | null,
  newSessionPending: boolean,
): boolean {
  return (
    !newSessionPending &&
    !!selectedChatId &&
    selectedChatId !== activeChatId
  );
}
