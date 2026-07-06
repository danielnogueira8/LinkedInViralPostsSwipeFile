import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { MarkdownDocument } from "@/components/markdown-document";

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
});
