import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HookCutoffPreview } from "@/components/hook-cutoff-marker";
import { hookCutoff, fitsInHook, hookCutoffHint, HOOK_LIMITS } from "@/lib/hook-cutoff";

// ---------------------------------------------------------------------------
// LinkedIn's "…see more" boundary.
//
// The model is a CHARACTER budget in which a line break is charged a penalty,
// not a hard stop. That's what reproduces the real behaviour: reported cutoffs
// land anywhere from ~120 to 210 characters depending on how the opening is
// broken up, because the snippet is a fixed number of RENDERED lines and an
// early return wastes the rest of a line.
//
// An earlier version counted whole lines and hard-stopped at 2. That cut tidily
// at a paragraph edge, which the feed never does — it truncates mid-sentence.
// ---------------------------------------------------------------------------

describe("plain prose", () => {
  test("a short post is not cut at all", () => {
    const r = hookCutoff("Short and sweet.", "mobile");
    expect(r.reason).toBe("none");
    expect(r.hidden).toBe("");
    expect(fitsInHook("Short and sweet.", "mobile")).toBe(true);
  });

  test("mobile cuts sooner than desktop", () => {
    const body =
      "LinkedIn didn't get worse because founders started using AI. It got worse because founders started using AI to sound like everyone else's AI, and the feed now reads like one long press release.";
    const m = hookCutoff(body, "mobile");
    const d = hookCutoff(body, "desktop");
    expect(m.reason).not.toBe("none");
    expect(m.visible.length).toBeLessThan(d.visible.length);
  });

  test("visible + hidden still reconstruct the body (modulo the trimmed seam)", () => {
    const body = "word ".repeat(120);
    const r = hookCutoff(body, "mobile");
    expect((r.visible + " " + r.hidden.trim()).replace(/\s+/g, " ").trim()).toBe(
      body.replace(/\s+/g, " ").trim(),
    );
  });
});

describe("it cuts like the feed does — mid-sentence, on a word boundary", () => {
  const body =
    "LinkedIn didn't get worse because founders started using AI. It got worse because founders started using AI to sound like everyone else's AI and nobody noticed.";

  test("never splits a word in half", () => {
    const { visible, hidden } = hookCutoff(body, "mobile");
    // the seam is whitespace in the original, so neither side ends/starts
    // mid-token
    expect(visible).toBe(visible.trimEnd());
    expect(/\S$/.test(visible)).toBe(true);
    const nextChar = hidden[0] ?? " ";
    expect(/\s/.test(nextChar) || /\s/.test(body[visible.length] ?? " ")).toBe(true);
  });

  test("cuts INSIDE a sentence, not neatly at its end", () => {
    const { visible } = hookCutoff(body, "mobile");
    // ~140 chars into this text lands mid second sentence
    expect(visible.endsWith(".")).toBe(false);
    expect(visible.length).toBeGreaterThan(60);
  });
});

describe("line breaks shorten the preview (the reason cutoffs vary 120-210)", () => {
  test("the same prose broken into lines shows LESS text", () => {
    const flat =
      "Founders keep making the same mistake with AI content and it is costing them the only advantage they had left in the feed.";
    const broken = flat.replace(/ and /, "\n\n");
    const a = hookCutoff(flat, "mobile");
    const b = hookCutoff(broken, "mobile");
    expect(b.visible.length).toBeLessThan(a.visible.length);
  });

  test("a paragraph break costs more than a single newline", () => {
    const base = "x".repeat(60);
    const single = hookCutoff(`${base}\n${base}`, "mobile");
    const para = hookCutoff(`${base}\n\n${base}`, "mobile");
    expect(para.visible.length).toBeLessThanOrEqual(single.visible.length);
  });

  test("a break-shortened cut is attributed to breaks, so the hint can say so", () => {
    const body = "One.\n\nTwo.\n\nThree.\n\nFour.\n\nFive.\n\nSix and some more words here.";
    expect(hookCutoff(body, "mobile").reason).toBe("breaks");
    expect(hookCutoffHint(body, "mobile")).toContain("line breaks");
  });

  test("a long unbroken first line is attributed to characters", () => {
    const body = "w".repeat(400);
    expect(hookCutoff(body, "mobile").reason).toBe("chars");
    expect(hookCutoffHint(body, "mobile")).toContain("140");
  });
});

describe("edge cases", () => {
  test("empty body", () => {
    expect(hookCutoff("", "mobile").reason).toBe("none");
  });

  test("a single very long word still gets cut (no infinite backtrack)", () => {
    const r = hookCutoff("z".repeat(400), "mobile");
    expect(r.reason).toBe("chars");
    expect(r.visible.length).toBeGreaterThan(0);
    expect(r.visible.length).toBeLessThanOrEqual(HOOK_LIMITS.mobile.chars);
  });

  test("hookCutoffHint is null when nothing is hidden", () => {
    expect(hookCutoffHint("tiny", "mobile")).toBeNull();
  });
});

describe("HookCutoffPreview renders the feed's affordance", () => {
  const render = (body: string, viewport: "mobile" | "desktop" = "mobile") =>
    renderToStaticMarkup(createElement(HookCutoffPreview, { body, viewport }));

  test("shows the ellipsis + 'see more' inline, and dims the remainder", () => {
    const html = render(`${"a".repeat(200)} HIDDEN-TAIL`);
    expect(html).toContain("see more");
    expect(html).toContain("…");
    expect(html).toContain("HIDDEN-TAIL"); // dimmed, never dropped
  });

  test("a short post renders plainly, with no cut affordance at all", () => {
    const html = render("Short hook.");
    expect(html).not.toContain("see more");
    expect(html).toContain("Short hook.");
  });
});
