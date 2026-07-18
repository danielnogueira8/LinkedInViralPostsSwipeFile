import { canonicalScrapedPostText } from "@/lib/agent/scraped-post-text";

export type ModelingSourceCandidateRecord = {
  id?: unknown;
  text?: unknown;
  post_url?: unknown;
  url?: unknown;
};

export type NormalizedModelingSourceCandidate = {
  id: string;
  text: string;
  url?: string;
  fingerprints: string[];
};

function normalizedHttpUrl(
  value: unknown,
): { url: string; fingerprint: string } | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return undefined;
    }
    // Fragments are client-side locations within the same resource. Protocol
    // and host are case-insensitive; path and query remain case-sensitive.
    parsed.hash = "";
    const url = parsed.toString();
    const fingerprint = `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${parsed.pathname}${parsed.search}`;
    return { url, fingerprint };
  } catch {
    return undefined;
  }
}

/**
 * The single source-of-truth for whether a retrieved post can become grounded
 * modeling evidence and how duplicate evidence is identified.
 */
export function normalizeModelingSourceCandidate(
  candidate: ModelingSourceCandidateRecord,
): NormalizedModelingSourceCandidate | null {
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const text = canonicalScrapedPostText(candidate.text);
  if (!id || !text) return null;

  const normalizedUrl = normalizedHttpUrl(candidate.post_url ?? candidate.url);
  const fingerprints = [
    `id:${id.toLocaleLowerCase("en-US")}`,
    ...(normalizedUrl ? [`url:${normalizedUrl.fingerprint}`] : []),
    `text:${text.replace(/\s+/g, " ").toLocaleLowerCase("en-US")}`,
  ];

  return {
    id,
    text,
    ...(normalizedUrl ? { url: normalizedUrl.url } : {}),
    fingerprints,
  };
}

export function admitDistinctModelingSource(
  candidate: NormalizedModelingSourceCandidate,
  seen: Set<string>,
): boolean {
  if (candidate.fingerprints.some((fingerprint) => seen.has(fingerprint))) {
    return false;
  }
  candidate.fingerprints.forEach((fingerprint) => seen.add(fingerprint));
  return true;
}
