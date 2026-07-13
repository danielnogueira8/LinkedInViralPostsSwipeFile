export function explicitlyRequestsSourceDiscovery(text: string): boolean {
  const normalized = text.toLowerCase();
  if (!normalized.trim()) return false;
  return (
    /\b(find|search|look\s+for|look\s+up|pull|grab|get|fetch|show|list|browse|scan)\b/i.test(
      normalized,
    ) &&
    /\b(latest|recent|top|viral|high[-\s]?performing|highest[-\s]?engagement|best|this\s+week|last\s+7\s+days|swipe\s+file|bookmarks?|tracked\s+accounts?|examples?|inspiration|source\s+posts?)\b/i.test(
      normalized,
    )
  );
}

export function freeTextLayersOpenChoice(text: string): boolean {
  const normalized = text.toLowerCase();
  if (!normalized.trim()) return false;
  if (/\b(\d{1,4}|two|three|four|five|six|seven|eight|nine|ten|a few|several|couple(?:\s+of)?|multiple)\s+(?:different\s+|more\s+|new\s+)?(variations?|versions?|posts?|hooks?|drafts?|takes?|angles?|options?|captions?|ideas?)\b/.test(normalized)) {
    return true;
  }
  if (/\b(both\b|(?:and|plus|as well as|combined?\s+with|merged?\s+with|mixed?\s+with)\s+(?:the|that|my|this\s+other)\b|(?:another|the\s+other|a\s+second|a\s+different)\s+(?:post|template|source|draft|one))/.test(normalized)) {
    return true;
  }
  return /\b(but\s+actually|instead\s+of\s+th(?:is|at)|ignore\s+(?:this|it|the\s+source)|don'?t\s+(?:use|follow|copy)\s+(?:this|it)|something\s+(?:totally|completely|entirely)\s+different|scrap\s+(?:this|it)|forget\s+(?:this|it|the\s+source))\b/.test(
    normalized,
  );
}
