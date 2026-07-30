import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import {
  GroundedSourceLinks,
  circularWindow,
} from "@/components/grounded-source-links";
import type { Artifact } from "@/lib/agent/contracts";
import { persistedCiteMeta } from "@/lib/agent/grounded-source-citations";

function cite(meta: Record<string, unknown>): Artifact {
  return {
    id: "grounded-source:10000000-0000-4000-8000-000000000001",
    kind: "cite",
    title: "Verified source post",
    body: "",
    meta: {
      postId: "10000000-0000-4000-8000-000000000001",
      presentation: "grounded_answer_source",
      ...meta,
    },
  };
}

// A full CitedPost as rehydrateCites fills it (the fields InlineSourceCard
// renders). A cite whose meta.card is this shape renders a rich card, not a chip.
function fullCard(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    text: "A viral post body about founder-led sales.",
    postUrl: `https://www.linkedin.com/posts/full-${id}`,
    postedAt: "2026-06-20T00:00:00Z",
    reactions: 512,
    comments: 44,
    reposts: 3,
    mediaType: "none",
    mediaUrls: [],
    visualKind: null,
    authorName: "Dana Founder",
    authorNiche: "B2B SaaS",
    authorAvatar: null,
    ...overrides,
  };
}

function render(artifacts: Artifact[]): string {
  return renderToStaticMarkup(
    createElement(GroundedSourceLinks, { artifacts }),
  );
}

describe("GroundedSourceLinks", () => {
  test("renders a live server-authored LinkedIn source as a safe link", () => {
    const html = render([
      cite({ sourceUrl: "https://www.linkedin.com/posts/example?trk=chat" }),
    ]);

    expect(html).toContain(
      'href="https://www.linkedin.com/posts/example?trk=chat"',
    );
    expect(html).toContain("View source post on LinkedIn");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
  });

  test("renders a rehydrated workspace-scoped citation after reload", () => {
    const postId = "10000000-0000-4000-8000-000000000001";
    const html = render([
      cite({
        card: {
          id: postId,
          postUrl: "https://linkedin.com/posts/rehydrated",
        },
      }),
    ]);

    expect(html).toContain('href="https://linkedin.com/posts/rehydrated"');
  });

  test("renders every verified source returned by the grounded-answer contract", () => {
    const artifacts = Array.from({ length: 10 }, (_, index) => {
      const sequence = String(index + 1).padStart(12, "0");
      const postId = `10000000-0000-4000-8000-${sequence}`;
      return {
        ...cite({ sourceUrl: `https://www.linkedin.com/posts/source-${index + 1}` }),
        id: `grounded-source:${postId}`,
        meta: {
          postId,
          presentation: "grounded_answer_source",
          sourceUrl: `https://www.linkedin.com/posts/source-${index + 1}`,
        },
      } satisfies Artifact;
    });

    const html = render(artifacts);

    expect(html).toContain('href="https://www.linkedin.com/posts/source-10"');
    expect(html.match(/<a /g)).toHaveLength(10);
  });

  test("drops arbitrary URLs, mismatched cards, and ordinary cite artifacts", () => {
    const postId = "10000000-0000-4000-8000-000000000001";
    const html = render([
      cite({ sourceUrl: "javascript:alert(1)" }),
      cite({ sourceUrl: "https://attacker.example/phish" }),
      cite({
        card: {
          id: "20000000-0000-4000-8000-000000000002",
          postUrl: "https://www.linkedin.com/posts/wrong-post",
        },
      }),
      {
        ...cite({ sourceUrl: "https://www.linkedin.com/posts/ordinary" }),
        meta: { postId, presentation: "ordinary_cite" },
      },
    ]);

    expect(html).toBe("");
  });

  // The rich-card path: a rehydrated full CitedPost renders as an InlineSourceCard,
  // not a chip. (rehydrateCites fills meta.card on chat load.)
  function citeWithCard(id: string, card: Record<string, unknown>): Artifact {
    return {
      ...cite({ card }),
      id: `grounded-source:${id}`,
      meta: { postId: id, presentation: "grounded_answer_source", card },
    } satisfies Artifact;
  }

  test("a single rehydrated full card renders as a rich card (author + body), not a chip", () => {
    const id = "10000000-0000-4000-8000-000000000001";
    const html = render([citeWithCard(id, fullCard(id))]);
    expect(html).toContain("Dana Founder"); // author from the card
    expect(html).toContain("founder-led sales"); // body from the card
    expect(html).toContain("max-w-[360px]");
    // no carousel controls for a single card
    expect(html).not.toContain('aria-label="Next source"');
  });

  test("a complete verified card still renders when the stored post has no LinkedIn URL", () => {
    const id = "10000000-0000-4000-8000-000000000001";
    const html = render([
      citeWithCard(id, fullCard(id, { postUrl: null })),
    ]);

    expect(html).toContain("Dana Founder");
    expect(html).toContain("founder-led sales");
    expect(html).not.toContain("<a ");
  });

  test("sources use the full chat width needed for a three-card carousel", () => {
    const ids = [
      "10000000-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000002",
      "10000000-0000-4000-8000-000000000003",
    ];
    const html = render(
      ids.map((id) => citeWithCard(id, fullCard(id))),
    );
    // Centered within the chat's own max-width, with room for three compact cards.
    expect(html).toContain("mx-auto");
    expect(html).toContain("max-w-4xl");
  });

  test("the carousel card renders compact (smaller media box)", () => {
    const ids = [
      "10000000-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000002",
    ];
    const html = render(
      ids.map((id) =>
        // A card WITH media so the compact media box is in the markup.
        citeWithCard(id, fullCard(id, { mediaType: "image", mediaUrls: ["https://media.example/x.jpg"] })),
      ),
    );
    // compact media box (aspect-[16/9] + capped height), not the full aspect-[16/10]
    expect(html).toContain("aspect-[16/9]");
    expect(html).toContain("max-h-40");
    expect(html).not.toContain("aspect-[16/10]");
    // Visible carousel media starts loading immediately and never degrades to a
    // blank gray box when a remote image cannot be fetched.
    expect(html.match(/loading="eager"/g)).toHaveLength(2);
    expect(html).toContain("Image unavailable");
  });

  test("multiple full cards render three at a time with the existing prev/next controls", () => {
    const ids = Array.from(
      { length: 5 },
      (_, index) =>
        `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    const html = render(
      ids.map((id, i) =>
        citeWithCard(id, fullCard(id, { authorName: `Author ${i + 1}` })),
      ),
    );
    // carousel controls present
    expect(html).toContain('aria-label="Previous source"');
    expect(html).toContain('aria-label="Next source"');
    // The window loops infinitely one card at a time, so there is one dot per
    // card (any card can lead the window), not one dot per page of three.
    expect(html.match(/aria-label="Go to source \d+"/g)).toHaveLength(5);
    // The initial carousel window contains exactly sources 1–3.
    expect(html).toContain("Sources 1–3 of 5");
    expect(html).toContain("Author 1");
    expect(html).toContain("Author 2");
    expect(html).toContain("Author 3");
    expect(html).not.toContain("Author 4");
    expect(html).not.toContain("Author 5");
  });

  test("the carousel window wraps around the end so it loops infinitely", () => {
    const items = [1, 2, 3, 4, 5];
    expect(circularWindow(items, 0, 3)).toEqual([1, 2, 3]);
    expect(circularWindow(items, 3, 3)).toEqual([4, 5, 1]);
    expect(circularWindow(items, 4, 3)).toEqual([5, 1, 2]);
    // fewer items than the window size just shows all of them
    expect(circularWindow(items, 0, 8)).toEqual([1, 2, 3, 4, 5]);
  });

  test("exactly three cards all render at once with no carousel controls", () => {
    const ids = Array.from(
      { length: 3 },
      (_, index) =>
        `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    const html = render(
      ids.map((id, i) =>
        citeWithCard(id, fullCard(id, { authorName: `Author ${i + 1}` })),
      ),
    );
    // All three fit in the window, so nothing can move — no controls, no counter.
    expect(html).toContain("Author 1");
    expect(html).toContain("Author 2");
    expect(html).toContain("Author 3");
    expect(html).not.toContain('aria-label="Previous source"');
    expect(html).not.toContain('aria-label="Next source"');
    expect(html).not.toContain("of 3");
  });

  test("mixes: a resolvable full card carousels, an unresolved source keeps its chip", () => {
    const id1 = "10000000-0000-4000-8000-000000000001";
    const id2 = "10000000-0000-4000-8000-000000000002";
    const html = render([
      citeWithCard(id1, fullCard(id1)),
      // second source has only a live URL, no full card → chip fallback
      {
        ...cite({ sourceUrl: "https://www.linkedin.com/posts/chip-only" }),
        id: `grounded-source:${id2}`,
        meta: {
          postId: id2,
          presentation: "grounded_answer_source",
          sourceUrl: "https://www.linkedin.com/posts/chip-only",
        },
      },
    ]);
    // one full card renders (single, not carousel — only 1 resolvable card)...
    expect(html).toContain("Dana Founder");
    expect(html).not.toContain('aria-label="Next source"');
    // ...and the unresolved source still shows a chip (nothing dropped).
    expect(html).toContain('href="https://www.linkedin.com/posts/chip-only"');
    expect(html).toContain("on LinkedIn");
  });

  test("numbers each carousel card with its absolute position in the source list", () => {
    const ids = Array.from(
      { length: 5 },
      (_, index) =>
        `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    const html = render(
      ids.map((id, i) =>
        citeWithCard(id, fullCard(id, { authorName: `Author ${i + 1}` })),
      ),
    );
    // The initial window shows sources 1–3, numbered so the user can map the
    // agent's "source 1 / 2 / 3" references onto the cards.
    expect(html).toContain('aria-label="Source 1"');
    expect(html).toContain('aria-label="Source 2"');
    expect(html).toContain('aria-label="Source 3"');
    expect(html).not.toContain('aria-label="Source 4"');
    expect(html).not.toContain('aria-label="Source 5"');
  });

  test("card numbers follow the full source list when an earlier source is chip-only", () => {
    const id1 = "10000000-0000-4000-8000-000000000001";
    const id2 = "10000000-0000-4000-8000-000000000002";
    const html = render([
      // first source has only a live URL, no full card → chip fallback
      {
        ...cite({ sourceUrl: "https://www.linkedin.com/posts/chip-only" }),
        id: `grounded-source:${id1}`,
        meta: {
          postId: id1,
          presentation: "grounded_answer_source",
          sourceUrl: "https://www.linkedin.com/posts/chip-only",
        },
      },
      citeWithCard(id2, fullCard(id2)),
    ]);
    // The card is source 2 in the agent's list even though it's the first card…
    expect(html).toContain('aria-label="Source 2"');
    expect(html).not.toContain('aria-label="Source 1"');
    // …and the unresolved source's chip names its own position, not its index
    // among chips.
    expect(html).toContain("View source 1 on LinkedIn");
  });

  test("a lone source card renders without a number chip", () => {
    const id = "10000000-0000-4000-8000-000000000001";
    const html = render([citeWithCard(id, fullCard(id))]);
    expect(html).not.toContain('aria-label="Source 1"');
  });

  test("persistence keeps only the validated live URL fallback and presentation marker", () => {
    expect(
      persistedCiteMeta({
        postId: "10000000-0000-4000-8000-000000000001",
        presentation: "grounded_answer_source",
        sourceUrl: "https://www.linkedin.com/posts/live-only",
        card: { postUrl: "https://www.linkedin.com/posts/stale" },
      }),
    ).toEqual({
      postId: "10000000-0000-4000-8000-000000000001",
      presentation: "grounded_answer_source",
      sourceUrl: "https://www.linkedin.com/posts/live-only",
    });
  });

  test("persistence rejects a forged fallback URL", () => {
    expect(
      persistedCiteMeta({
        postId: "10000000-0000-4000-8000-000000000001",
        presentation: "grounded_answer_source",
        sourceUrl: "https://attacker.example/phish",
      }),
    ).toEqual({
      postId: "10000000-0000-4000-8000-000000000001",
      presentation: "grounded_answer_source",
    });
  });
});
