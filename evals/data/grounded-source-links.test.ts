import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { GroundedSourceLinks } from "@/components/grounded-source-links";
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

  test("sources are centered and width-capped (~a Swipe File card), not full width", () => {
    const id = "10000000-0000-4000-8000-000000000001";
    const html = render([citeWithCard(id, fullCard(id))]);
    // centered + max-width constrained container (editorial, not full-bleed)
    expect(html).toContain("mx-auto");
    expect(html).toContain("max-w-[360px]");
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
  });

  test("multiple full cards render a carousel: one card + prev/next + a dot per source", () => {
    const ids = [
      "10000000-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000002",
      "10000000-0000-4000-8000-000000000003",
    ];
    const html = render(
      ids.map((id, i) =>
        citeWithCard(id, fullCard(id, { authorName: `Author ${i + 1}` })),
      ),
    );
    // carousel controls present
    expect(html).toContain('aria-label="Previous source"');
    expect(html).toContain('aria-label="Next source"');
    // one dot per source (3)
    expect(html.match(/aria-label="Go to source \d+"/g)).toHaveLength(3);
    // "Source 1 of 3" position label + only the FIRST card is rendered at a time
    expect(html).toContain("Source 1 of 3");
    expect(html).toContain("Author 1");
    expect(html).not.toContain("Author 2"); // one at a time
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
