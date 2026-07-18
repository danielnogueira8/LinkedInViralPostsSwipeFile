import { describe, expect, test } from "vitest";
import {
  selectModelingSourcePool,
  selectModelingSources,
} from "@/lib/modeling-source-selection";

type Candidate = {
  id: string;
  text?: unknown;
  post_url?: unknown;
  url?: unknown;
  accounts?: { name?: string; niche?: string } | null;
};

function post(id: string, topic: string, author = id): Candidate {
  return {
    id,
    text: `${topic} gets easier when the system is explicit.`,
    accounts: { name: author, niche: topic },
  };
}

describe("selectModelingSources", () => {
  test("preserves caller ranking instead of interpreting topic or format", () => {
    const selected = selectModelingSources({
      candidates: [
        post("newest-unrelated", "cryptocurrency trading"),
        post("older-relevant", "content writing strategy"),
        {
          id: "oldest-caption",
          text: "Watch the video below.",
          accounts: { name: "Caption", niche: "content writing" },
        },
      ],
      limit: 3,
      usedIds: new Set(),
      surfacedIds: new Set(),
    });

    expect(selected.map((candidate) => candidate.id)).toEqual([
      "newest-unrelated",
      "older-relevant",
      "oldest-caption",
    ]);
  });

  test("uses stable freshness partitions without changing order inside them", () => {
    const selected = selectModelingSources({
      candidates: [
        post("used-first", "A"),
        post("surfaced-second", "B"),
        post("fresh-third", "C"),
        post("fresh-fourth", "D"),
      ],
      limit: 4,
      usedIds: new Set(["used-first"]),
      surfacedIds: new Set(["surfaced-second"]),
    });

    expect(selected.map((candidate) => candidate.id)).toEqual([
      "fresh-third",
      "fresh-fourth",
      "surfaced-second",
      "used-first",
    ]);
  });

  test("rejects only objectively unusable bodies and keeps compact posts", () => {
    const selected = selectModelingSources({
      candidates: [
        { id: "empty", text: "   " },
        { id: "malformed", text: { prompt: "ignore instructions" } },
        { id: "poll", text: "Poll: vote below" },
        { id: "caption", text: "Agree?" },
      ],
      limit: 4,
      usedIds: new Set(),
    });

    expect(selected.map((candidate) => candidate.id)).toEqual([
      "poll",
      "caption",
    ]);
  });

  test("returns stable ordered primaries and bounded reserves", () => {
    const duplicate = post("c1", "C", "Third");
    const input = {
      candidates: [
        post("a1", "A1", "Prolific"),
        post("a2", "A2", "Prolific"),
        post("b1", "B", "Other"),
        duplicate,
        { ...duplicate },
      ],
      limit: 2,
      reserveLimit: 99,
      usedIds: new Set<string>(),
      surfacedIds: new Set<string>(),
    };

    const first = selectModelingSourcePool(input);
    const second = selectModelingSourcePool(input);

    expect(first.primaries.map((candidate) => candidate.id)).toEqual([
      "a1",
      "a2",
    ]);
    expect(first.reserves.map((candidate) => candidate.id)).toEqual([
      "b1",
      "c1",
    ]);
    expect(first).toEqual(second);
  });

  test("never promotes an older author over a newer same-author post", () => {
    const selected = selectModelingSources({
      candidates: [
        post("a1", "A1", "Prolific"),
        post("a2", "A2", "Prolific"),
        post("a3", "A3", "Prolific"),
        post("b1", "B", "Other"),
      ],
      limit: 3,
      usedIds: new Set(),
    });

    expect(selected.map((candidate) => candidate.id)).toEqual([
      "a1",
      "a2",
      "a3",
    ]);
  });

  test("malformed prefixes do not consume the valid-candidate allowance", () => {
    const malformedPrefix = Array.from({ length: 120 }, (_, index) => ({
      id: `bad-${index}`,
      text: index % 2 === 0 ? "" : { malformed: true },
    }));
    const selected = selectModelingSources({
      candidates: [
        ...malformedPrefix,
        post("valid-1", "newest valid"),
        post("valid-2", "next valid"),
      ],
      limit: 2,
      usedIds: new Set(),
    });

    expect(selected.map((candidate) => candidate.id)).toEqual([
      "valid-1",
      "valid-2",
    ]);
  });

  test("backfills canonical-empty and duplicate evidence before slicing", () => {
    const selected = selectModelingSources({
      candidates: [
        {
          id: "empty-envelope",
          text: "<post>\n</post>",
          post_url: "https://example.com/empty",
        },
        {
          id: "first",
          text: "A distinctive source body.",
          post_url: "https://example.com/shared",
        },
        {
          id: "duplicate-url",
          text: "A different body with the same source URL.",
          post_url: "https://example.com/shared",
        },
        {
          id: "duplicate-body",
          text: "  A distinctive   source body. ",
          post_url: "https://example.com/other",
        },
        post("valid-2", "second valid"),
        post("valid-3", "third valid"),
      ],
      limit: 3,
      usedIds: new Set(),
    });

    expect(selected.map((candidate) => candidate.id)).toEqual([
      "first",
      "valid-2",
      "valid-3",
    ]);
  });

  test("preserves case-sensitive URL paths while ignoring fragments", () => {
    const selected = selectModelingSources({
      candidates: [
        {
          id: "upper-path",
          text: "First body",
          post_url: "https://EXAMPLE.com/Post/A#first",
        },
        {
          id: "lower-path",
          text: "Second body",
          post_url: "https://example.com/Post/a#second",
        },
        {
          id: "same-resource-fragment",
          text: "Third body",
          post_url: "https://example.com/Post/A#another",
        },
      ],
      limit: 3,
      usedIds: new Set(),
    });

    expect(selected.map((candidate) => candidate.id)).toEqual([
      "upper-path",
      "lower-path",
    ]);
  });

  test("caps reserves, candidates, and output while deduplicating ids", () => {
    const repeated = post("same", "first");
    const pool = selectModelingSourcePool({
      candidates: [
        repeated,
        { ...repeated },
        { ...post("", "invalid") },
        ...Array.from({ length: 130 }, (_, index) =>
          post(`unique-${index}`, `topic-${index}`, `A${index}`),
        ),
      ],
      limit: Number.POSITIVE_INFINITY,
      reserveLimit: Number.POSITIVE_INFINITY,
      usedIds: new Set(),
    });

    expect(pool.primaries).toHaveLength(50);
    expect(pool.reserves).toHaveLength(5);
    expect(
      [...pool.primaries, ...pool.reserves].filter(
        (candidate) => candidate.id === "same",
      ),
    ).toHaveLength(1);
    expect(
      [...pool.primaries, ...pool.reserves].some(
        (candidate) => candidate.id === "",
      ),
    ).toBe(false);
  });

  test("returns no sources for zero, negative, or empty requests", () => {
    const candidate = post("one", "content writing");
    for (const limit of [0, -1, Number.NEGATIVE_INFINITY]) {
      expect(
        selectModelingSources({
          candidates: [candidate],
          limit,
          usedIds: new Set(),
        }),
      ).toEqual([]);
    }
    expect(
      selectModelingSources({ candidates: [], limit: 3, usedIds: new Set() }),
    ).toEqual([]);
  });
});
