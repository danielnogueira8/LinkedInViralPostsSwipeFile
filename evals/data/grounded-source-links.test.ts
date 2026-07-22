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
