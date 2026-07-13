export const draftKey = (id: string | null) =>
  `swipein:chat-draft:${id ?? "__new__"}`;

export function readDraft(id: string | null): string {
  try {
    return localStorage.getItem(draftKey(id)) ?? "";
  } catch {
    return "";
  }
}

export function writeDraft(id: string | null, text: string): void {
  try {
    if (text.trim()) localStorage.setItem(draftKey(id), text);
    else localStorage.removeItem(draftKey(id));
  } catch {
    // Draft persistence is best-effort; storage can be disabled by the browser.
  }
}
