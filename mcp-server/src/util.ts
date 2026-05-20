export function normalizeProfileUrl(raw: string): string | null {
  const m = raw.trim().match(/linkedin\.com\/in\/([^\/\?#]+)/i);
  if (!m) return null;
  return `https://www.linkedin.com/in/${m[1].toLowerCase()}`;
}

export function handleFromUrl(url: string): string {
  const m = url.match(/linkedin\.com\/in\/([^\/\?#]+)/i);
  return m ? m[1].toLowerCase() : url.toLowerCase();
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDayStart(d?: string): string | null {
  if (!d || !DATE_RE.test(d)) return null;
  const dt = new Date(`${d}T00:00:00.000Z`);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

export function parseDayEnd(d?: string): string | null {
  if (!d || !DATE_RE.test(d)) return null;
  const dt = new Date(`${d}T23:59:59.999Z`);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

export function sinceCutoff(since?: string): string | null {
  const days = since === "1d" ? 1 : since === "7d" ? 7 : since === "30d" ? 30 : null;
  if (!days) return null;
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
}

export function jsonContent(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

export function errorContent(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: message }) }],
    isError: true,
  };
}
