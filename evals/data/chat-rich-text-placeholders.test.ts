import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { renderInline, renderRichText } from "@/components/chat-rich-text";

// renderInline/renderRichText return React nodes; rendering to static markup
// lets these tests assert on the actual DOM shape (a real <mark> element)
// without pulling in a JSDOM/RTL harness this suite doesn't otherwise use.
function html(node: ReturnType<typeof renderInline>): string {
  return renderToStaticMarkup(node as never);
}

describe("renderInline — bracket placeholder highlighting", () => {
  test("wraps a single unfilled placeholder in a <mark>", () => {
    const out = html(renderInline("The turning point was [insert the specific moment]."));
    expect(out).toContain("<mark");
    expect(out).toContain("[insert the specific moment]");
    expect(out).not.toContain("<mark></mark>");
  });

  test("plain text with no brackets renders unchanged (no <mark>)", () => {
    const out = html(renderInline("I started my career writing code."));
    expect(out).not.toContain("<mark");
    expect(out).toContain("I started my career writing code.");
  });

  test("highlights multiple distinct placeholders in the same line", () => {
    const out = html(
      renderInline("Write about [topic] and mention [company name] specifically."),
    );
    const markCount = (out.match(/<mark/g) ?? []).length;
    expect(markCount).toBe(2);
    expect(out).toContain("[topic]");
    expect(out).toContain("[company name]");
  });

  test("does not treat bracketed prose with internal sentence punctuation as a placeholder", () => {
    // Matches the CONSERVATIVE contract already established by
    // lib/chat-composer-policy.ts's PLACEHOLDER_RE (a placeholder is bare
    // letters/spaces/hyphens/slashes only) — this is not a new rule, just
    // reused by the renderer. A bracket span with a period/comma/etc INSIDE
    // it reads as a real aside the user typed, not an unfilled slot.
    const out = html(renderInline("Check the source [see docs, e.g. this one]."));
    expect(out).not.toContain("<mark");
  });

  test("highlights a placeholder inside bold text", () => {
    const out = html(renderInline("**[insert stat here]** changed everything."));
    expect(out).toContain("<strong");
    expect(out).toContain("<mark");
    expect(out).toContain("[insert stat here]");
  });

  test("highlights a placeholder inside italic text", () => {
    const out = html(renderInline("_[insert quote]_ was the turning point."));
    expect(out).toContain("<em");
    expect(out).toContain("<mark");
  });

  test("every rendered node has a unique key across mixed bold/italic/placeholder segments (no React key-collision warning surface)", () => {
    // Regression guard for the shared nextKey() counter: previously each
    // segment reset its own key counter, which could collide across
    // plain-text / bold / italic / placeholder boundaries in the same line.
    const out = html(
      renderInline(
        "Intro [topic]. **Bold [company name] claim.** Then _[insert quote] here_ and more [detail] text.",
      ),
    );
    const markCount = (out.match(/<mark/g) ?? []).length;
    expect(markCount).toBe(4);
  });
});

describe("renderRichText — placeholder highlighting survives block-level rendering (lists/quotes)", () => {
  test("highlights a placeholder inside a chat-mode list item", () => {
    const out = html(
      renderRichText("Here's the plan:\n- Step one\n- Fill in [specific detail] here\n", "chat"),
    );
    expect(out).toContain("<mark");
    expect(out).toContain("[specific detail]");
  });

  test("highlights a placeholder inside a draft-mode post body (the real bug scenario)", () => {
    const draft = [
      "I started my career writing code.",
      "",
      "The turning point was [insert the specific moment that made you choose ghostwriting].",
      "",
      "After that, I stopped treating writing like a side skill.",
    ].join("\n");
    const out = html(renderRichText(draft, "draft"));
    expect(out).toContain("<mark");
    expect(out).toContain("[insert the specific moment that made you choose ghostwriting]");
  });

  test("a draft with no placeholders renders with no <mark> at all", () => {
    const draft = "I started my career writing code.\n\nNow I write LinkedIn content for founders.";
    const out = html(renderRichText(draft, "draft"));
    expect(out).not.toContain("<mark");
  });
});
