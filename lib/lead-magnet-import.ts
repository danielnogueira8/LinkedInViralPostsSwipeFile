import { LEAD_MAGNET_BODY_MAX } from "./lead-magnets";
import net from "node:net";

export type ImportedLeadMagnet = {
  title: string;
  markdown: string;
};

const FETCH_TIMEOUT_MS = 12_000;
const NOTION_JS_PLACEHOLDER =
  "Notion JavaScript must be enabled in order to use Notion";
const IMPORT_FETCH_RETRIES = 1;

export async function importLeadMagnetFromUrl(url: string): Promise<ImportedLeadMagnet> {
  const target = normalizeImportUrl(url);
  assertSafeImportUrl(target);
  if (isNotionUrl(target)) {
    let notionImport: ImportedLeadMagnet | null = null;
    try {
      notionImport = await importNotionPage(target);
    } catch (e) {
      if (isImportNetworkError(e)) throw e;
    }
    if (notionImport) return notionImport;
    throw new Error(
      "I couldn't read that Notion page. Make sure it is shared publicly to the web, not only shared inside Notion.",
    );
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchWithRetry(target, {
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
    if (raw.includes(NOTION_JS_PLACEHOLDER)) {
      const notionImport = await importNotionPage(target).catch(() => null);
      if (notionImport) return notionImport;
      throw new Error(
        "I couldn't read that Notion page. Make sure it is shared publicly to the web, not only shared inside Notion.",
      );
    }
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
    if (isAbortError(e)) {
      throw new Error("That page took too long to load. Make sure it is public and try again.");
    }
    if (isFetchFailedError(e)) {
      throw new Error("I couldn't reach that public page. Make sure the link is public and try again.");
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function assertSafeImportUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Use a valid public URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Use an http or https public URL.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Use a public URL without embedded credentials.");
  }
  if (isLocalOrPrivateHost(parsed.hostname)) {
    throw new Error("Use a public URL, not a local or private network address.");
  }
}

function isLocalOrPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    return true;
  }
  const ipVersion = net.isIP(host);
  if (ipVersion === 4) {
    const parts = host.split(".").map((part) => Number(part));
    const [a, b] = parts;
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (ipVersion === 6) {
    return (
      host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("fe80:")
    );
  }
  return false;
}

type NotionTextFragment = [string, unknown?];
type NotionBlockValue = {
  id: string;
  type: string;
  properties?: {
    title?: NotionTextFragment[];
    checked?: NotionTextFragment[];
  };
  content?: string[];
  format?: {
    page_icon?: string;
    code_language?: string;
  };
};
type NotionBlockRecord = {
  value?: NotionBlockValue | { value?: NotionBlockValue };
};
type NotionRecordMap = {
  block?: Record<string, NotionBlockRecord>;
};

async function importNotionPage(url: string): Promise<ImportedLeadMagnet | null> {
  const pageId = extractNotionPageId(url);
  if (!pageId) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchWithRetry("https://www.notion.so/api/v3/loadPageChunk", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": "SwipeIn lead magnet importer",
        "notion-client-version": "23.13.0.0",
      },
      body: JSON.stringify({
        pageId,
        limit: 100,
        cursor: { stack: [] },
        chunkNumber: 0,
        verticalColumns: false,
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { recordMap?: NotionRecordMap };
    return parseNotionRecordMap(json.recordMap, pageId, url);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithRetry(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= IMPORT_FETCH_RETRIES; attempt += 1) {
    try {
      return await fetch(input, init);
    } catch (e) {
      lastError = e;
      if (isAbortError(e) || attempt >= IMPORT_FETCH_RETRIES) break;
      await sleep(250);
    }
  }
  throw normalizeFetchError(lastError);
}

function normalizeFetchError(e: unknown): Error {
  if (isAbortError(e)) {
    return new Error("That page took too long to load. Make sure it is public and try again.");
  }
  if (isFetchFailedError(e)) {
    return new Error("I couldn't reach that public page. Make sure the link is public and try again.");
  }
  return e instanceof Error ? e : new Error("I couldn't reach that public page. Make sure the link is public and try again.");
}

function isAbortError(e: unknown): boolean {
  return (e as Error | undefined)?.name === "AbortError";
}

function isFetchFailedError(e: unknown): boolean {
  const message = (e as Error | undefined)?.message ?? "";
  return e instanceof TypeError || /fetch failed|network|connection|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(message);
}

function isImportNetworkError(e: unknown): boolean {
  const message = (e as Error | undefined)?.message ?? "";
  return (
    isAbortError(e) ||
    isFetchFailedError(e) ||
    message.startsWith("I couldn't reach that public page.") ||
    message.startsWith("That page took too long to load.")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseNotionRecordMap(
  recordMap: NotionRecordMap | undefined,
  pageId: string,
  fallbackUrl: string,
): ImportedLeadMagnet | null {
  const blocks = recordMap?.block ?? {};
  const page =
    notionBlockFromRecord(blocks[pageId]) ??
    Object.values(blocks)
      .map(notionBlockFromRecord)
      .find((block) => block?.type === "page");
  if (!page) return null;
  const title = notionPlainText(page.properties?.title) || extractTitle("", fallbackUrl);
  const visited = new Set<string>();
  const rendered = renderNotionChildren(page.content ?? [], blocks, visited)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const markdown = [`# ${title}`, rendered].filter(Boolean).join("\n\n");
  const cleaned = markdown.trim().slice(0, LEAD_MAGNET_BODY_MAX);
  return cleaned.length >= 40 ? { title, markdown: cleaned } : null;
}

function notionBlockFromRecord(record: NotionBlockRecord | undefined): NotionBlockValue | undefined {
  const value = record?.value;
  if (!value) return undefined;
  if (isNotionBlockValue(value)) return value;
  const nested = value.value;
  return isNotionBlockValue(nested) ? nested : undefined;
}

function isNotionBlockValue(value: unknown): value is NotionBlockValue {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function renderNotionChildren(
  ids: string[],
  blocks: NonNullable<NotionRecordMap["block"]>,
  visited: Set<string>,
): string {
  const out: string[] = [];
  let number = 1;
  for (const id of ids) {
    if (visited.has(id)) continue;
    visited.add(id);
    const block = notionBlockFromRecord(blocks[id]);
    if (!block) continue;
    const rendered = renderNotionBlock(block, blocks, visited, number);
    if (block.type === "numbered_list" && rendered) number += 1;
    else if (block.type !== "numbered_list") number = 1;
    if (rendered) out.push(rendered);
  }
  return out.join("\n\n");
}

function renderNotionBlock(
  block: NotionBlockValue,
  blocks: NonNullable<NotionRecordMap["block"]>,
  visited: Set<string>,
  number: number,
): string {
  const text = notionPlainText(block.properties?.title);
  const children = block.content?.length
    ? renderNotionChildren(block.content, blocks, visited)
    : "";
  switch (block.type) {
    case "header":
      return `## ${text}`;
    case "sub_header":
      return `### ${text}`;
    case "sub_sub_header":
      return `#### ${text}`;
    case "bulleted_list":
      return [`- ${text}`, indentMarkdown(children)].filter(Boolean).join("\n");
    case "numbered_list":
      return [`${number}. ${text}`, indentMarkdown(children)].filter(Boolean).join("\n");
    case "to_do": {
      const checked = notionPlainText(block.properties?.checked) === "Yes" ? "x" : " ";
      return [`- [${checked}] ${text}`, indentMarkdown(children)].filter(Boolean).join("\n");
    }
    case "quote":
      return `> ${text}`;
    case "code":
      return [`\`\`\`${block.format?.code_language ?? ""}`, text, "```"].join("\n");
    case "callout": {
      const icon = typeof block.format?.page_icon === "string" ? `${block.format.page_icon} ` : "";
      return [`> ${icon}${text}`, indentMarkdown(children, "> ")].filter(Boolean).join("\n");
    }
    case "toggle":
      return [`- ${text}`, indentMarkdown(children)].filter(Boolean).join("\n");
    case "divider":
      return "---";
    case "text":
    case "page":
    default:
      return [text, children].filter(Boolean).join("\n\n");
  }
}

function notionPlainText(parts: NotionTextFragment[] | undefined): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => (Array.isArray(part) && typeof part[0] === "string" ? part[0] : ""))
    .join("")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function indentMarkdown(value: string, prefix = "  "): string {
  if (!value.trim()) return "";
  return value
    .split("\n")
    .map((line) => (line.trim() ? `${prefix}${line}` : line))
    .join("\n");
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

export function isNotionUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "notion.so" || host.endsWith(".notion.so") || host.endsWith(".notion.site");
  } catch {
    return false;
  }
}

export function extractNotionPageId(url: string): string | null {
  try {
    const u = new URL(url);
    const fromQuery = u.searchParams.get("p") ?? u.searchParams.get("pageId");
    const raw = fromQuery
      ? fromQuery.replace(/-/g, "")
      : (u.pathname.split("/").filter(Boolean).pop() ?? "").replace(/-/g, "");
    const match = raw.match(/([a-f0-9]{32})$/i);
    if (!match) return null;
    const id = match[1].toLowerCase();
    return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
  } catch {
    return null;
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
