import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import {
  MarkdownDocument,
  markdownTableOfContents,
} from "@/components/markdown-document";

describe("MarkdownDocument", () => {
  test("renders markdown links as clickable anchors", () => {
    const html = renderToStaticMarkup(
      React.createElement(MarkdownDocument, {
        markdown:
          "Want feedback on your story tweets or a content strategy built around them? [Book a 30-min call](https://calendly.com/danielhenriquesnogueira/30min) and let's map it out together.",
      }),
    );

    expect(html).toContain(
      'href="https://calendly.com/danielhenriquesnogueira/30min"',
    );
    expect(html).toContain(">Book a 30-min call</a>");
  });

  test("renders pasted raw URLs as links without swallowing punctuation", () => {
    const html = renderToStaticMarkup(
      React.createElement(MarkdownDocument, {
        markdown:
          "Book here: https://calendly.com/danielhenriquesnogueira/30min.",
      }),
    );

    expect(html).toContain(
      'href="https://calendly.com/danielhenriquesnogueira/30min"',
    );
    expect(html).toContain(">https://calendly.com/danielhenriquesnogueira/30min</a>.");
  });

  test("gives document headings stable anchors and exposes a matching table of contents", () => {
    const markdown = "## Start here\n\nDo this first.\n\n## Start here\n\nThen do it again.";
    const html = renderToStaticMarkup(
      React.createElement(MarkdownDocument, { markdown }),
    );

    expect(markdownTableOfContents(markdown)).toEqual([
      { id: "start-here", level: 2, text: "Start here" },
      { id: "start-here-2", level: 2, text: "Start here" },
    ]);
    expect(html).toContain('id="start-here"');
    expect(html).toContain('id="start-here-2"');
  });

  test("renders horizontal rules and task-list items as document UI instead of raw markers", () => {
    const html = renderToStaticMarkup(
      React.createElement(MarkdownDocument, {
        markdown: "Before\n\n---\n\n- [ ] Draft the hook\n- [x] Pick the angle",
      }),
    );

    expect(html).toContain("<hr");
    expect(html).not.toContain(">&lt;!--");
    expect(html).not.toContain("[ ] Draft the hook");
    expect(html).not.toContain("[x] Pick the angle");
    expect(html).toContain("Draft the hook");
    expect(html).toContain("Pick the angle");
  });
});
