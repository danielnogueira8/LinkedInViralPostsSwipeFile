export function postsDraftHref(draftId: string): string {
  return `/dashboard/posts?draft=${encodeURIComponent(draftId)}`;
}

export const NEW_CONVERSATION_HREF = "/dashboard?new=1";

export function requestedDraftId(
  requested: string | string[] | undefined,
): string | null {
  const value = Array.isArray(requested) ? requested[0] : requested;
  const normalized = value?.trim();
  return normalized || null;
}
