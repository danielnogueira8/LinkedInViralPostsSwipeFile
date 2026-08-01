import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  culturalMomentQuery,
  dedupeNewsEvidence,
} from "@/lib/agent-inbox/evidence";
import type { AgentInboxEvidence } from "@/lib/agent-inbox";

const synthesisSource = readFileSync(
  new URL("../../lib/agent-inbox/synthesis.ts", import.meta.url),
  "utf8",
);

function newsItem(
  overrides: Partial<AgentInboxEvidence> = {},
): AgentInboxEvidence {
  return {
    kind: "news",
    label: "A story",
    detail: "Detail",
    url: "https://example.test/a",
    ...overrides,
  };
}

describe("cultural moment query", () => {
  test("carries no workspace or niche terms", () => {
    const query = culturalMomentQuery();
    // The whole point: the niche query can only ever return trade press, so
    // this one must be reachable without any workspace input. If a topic ever
    // leaks in, cultural moments stop being reachable for everyone whose
    // niche does not happen to match.
    expect(query).not.toMatch(/\bOR\b/);
    expect(query).not.toMatch(/industry developments/);
    expect(query).not.toMatch(/product changes/);
  });

  test("is a stable constant, so every workspace shares one cache key", () => {
    // The news pool caches by normalized query. A query with no per-workspace
    // terms normalizes identically everywhere, so the product pays for one
    // search per window rather than one per workspace.
    expect(culturalMomentQuery()).toBe(culturalMomentQuery());
  });

  test("does not ask for politics, crime, disaster, or conflict", () => {
    const query = culturalMomentQuery().toLowerCase();
    // Culturally loud but exactly where borrowing attention reads as
    // opportunistic. SENSITIVE_NEWS_RE still filters defensively; not asking
    // is better than filtering after the fact.
    // Word-boundary matched: a substring check reports "awards" as "war".
    for (const term of [
      "politics",
      "election",
      "crime",
      "shooting",
      "war",
      "disaster",
    ]) {
      expect(query).not.toMatch(new RegExp(`\\b${term}\\b`));
    }
  });

  test("asks for the moment kinds the newsjacking framework relies on", () => {
    const query = culturalMomentQuery().toLowerCase();
    expect(query).toContain("sports");
    expect(query).toContain("awards");
    expect(query).toContain("entertainment");
  });
});

describe("news pool dedupe", () => {
  test("drops a story surfaced by both the niche and cultural pools", () => {
    // A platform change is both industry news and a moment everyone is
    // discussing. Without dedupe the synthesizer sees one article twice and
    // can build two cards on it — the duplicate-pitch problem the per-source
    // guard exists to prevent.
    const merged = dedupeNewsEvidence([
      newsItem({ label: "Niche framing", url: "https://example.test/same" }),
      newsItem({ label: "Cultural framing", url: "https://example.test/same" }),
    ]);
    expect(merged).toHaveLength(1);
    // First occurrence wins, and the niche pool is passed first.
    expect(merged[0].label).toBe("Niche framing");
  });

  test("keeps genuinely distinct stories from both pools", () => {
    const merged = dedupeNewsEvidence([
      newsItem({ label: "Trade story", url: "https://example.test/a" }),
      newsItem({ label: "Cultural moment", url: "https://example.test/b" }),
    ]);
    expect(merged.map((entry) => entry.label)).toEqual([
      "Trade story",
      "Cultural moment",
    ]);
  });

  test("falls back to ref then label when a story has no url", () => {
    const merged = dedupeNewsEvidence([
      newsItem({ url: null, ref: "post-1", label: "By ref" }),
      newsItem({ url: null, ref: "post-1", label: "Same ref" }),
      newsItem({ url: null, ref: null, label: "By label" }),
      newsItem({ url: null, ref: null, label: "By label" }),
    ]);
    expect(merged.map((entry) => entry.label)).toEqual(["By ref", "By label"]);
  });
});

describe("synthesis prompt", () => {
  test("authorizes a non-niche cultural moment for the NOW lane", () => {
    // Without this the new evidence is unusable: the prompt described NOW as
    // timely but never said an N item could be unrelated to the user's field.
    expect(synthesisSource).toContain("cultural moment");
    expect(synthesisSource).toContain("not about their field at all");
  });

  test("requires an explicit one-step bridge and rejects a stretch", () => {
    // The quality bar for the whole framework. A tortured tie-in is the
    // failure mode of newsjacking, so the model is told to drop the idea
    // rather than ship a stretch.
    expect(synthesisSource).toContain("state the bridge to this user's work");
    expect(synthesisSource).toContain("DO NOT return the idea");
  });
});
