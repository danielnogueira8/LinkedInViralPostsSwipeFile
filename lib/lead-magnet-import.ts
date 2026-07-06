import { LEAD_MAGNET_BODY_MAX } from "./lead-magnets";

export type ImportedLeadMagnet = {
  title: string;
  markdown: string;
};

const FETCH_TIMEOUT_MS = 12_000;

export async function importLeadMagnetFromUrl(url: string): Promise<ImportedLeadMagnet> {
  const target = normalizeImportUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(target, {
      signal: controller.signal,
      headers: {
        "user-agent": "SwipeIn lead magnet importer",
        accept: "text/html,text/plain,text/markdown,application/xhtml+xml,*/*;q=0.8",
      },
    });
    if (!res.ok) {
      throw new Error(`Couldn't fetch that public page (${res.status}).`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    const raw = (await res.text()).slice(0, 1_500_000);
    const title = extractTitle(raw, url);
    const markdown = contentType.includes("text/plain") || target.includes("/export?format=txt")
      ? plainTextToMarkdown(raw)
      : htmlToMarkdown(raw);
    const cleaned = markdown.trim().slice(0, LEAD_MAGNET_BODY_MAX);
    if (cleaned.length < 40) {
      throw new Error("I couldn't find enough readable content on that public page.");
    }
    return { title, markdown: cleaned };
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      throw new Error("That page took too long to load. Make sure it is public and try again.");
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeImportUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === "docs.google.com" && u.pathname.includes("/document/d/")) {
      const match = u.pathname.match(/\/document\/d\/([^/]+)/);
      if (match?.[1]) return `https://docs.google.com/document/d/${match[1]}/export?format=txt`;
    }
    return u.toString();
  } catch {
    return url;
  }
}

function extractTitle(raw: string, fallbackUrl: string): string {
  const meta =
    raw.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
    raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const decoded = decodeEntities(stripTags(meta ?? "")).replace(/\s+/g, " ").trim();
  if (decoded) return decoded.replace(/\s*[|-]\s*(Notion|Google Docs).*$/i, "").slice(0, 160);
  try {
    const u = new URL(fallbackUrl);
    return decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "Lead magnet").slice(0, 160);
  } catch {
    return "Imported lead magnet";
  }
}

function htmlToMarkdown(html: string): string {
  let input = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer)>/gi, "\n\n")
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n\n# $1\n\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n\n## $1\n\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n\n### $1\n\n")
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, "\n\n> $1\n\n")
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**")
    .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, "**$1**")
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
  input = stripTags(input);
  return plainTextToMarkdown(decodeEntities(input));
}

function plainTextToMarkdown(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
