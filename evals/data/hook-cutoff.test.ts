import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HookCutoffPreview } from "@/components/hook-cutoff-marker";
import {
  hookCutoff,
  fitsInHook,
  hookCutoffHint,
  HOOK_LIMITS,
} from "@/lib/hook-cutoff";

// ---------------------------------------------------------------------------
// LinkedIn's "…see more" boundary. The interesting behaviour — and the thing a
// naive body.slice(0, 140) gets wrong — is that the LINE budget can bite before
// the character budget, so a short hook written across several lines is cut
// early. That's what most of these pin down.
// ---------------------------------------------------------------------------

describe("character budget", () => {
  test("a short single-line post is not cut at all", () => {
    const r = hookCutoff("Short and sweet.", "mobile");
    expect(r.reason).toBe("none");
    expect(r.hidden).toBe("");
    expect(r.visible).toBe("Short and sweet.");
    expect(fitsInHook("Short and sweet.", "mobile")).toBe(true);
  });

  test("cuts at 140 on mobile and 210 on desktop", () => {
    const body = "x".repeat(400);
    expect(hookCutoff(body, "mobile").index).toBe(140);
    expect(hookCutoff(body, "desktop").index).toBe(210);
    expect(hookCutoff(body, "mobile").reason).toBe("chars");
  });

  test("mobile is the tighter limit, so it hides more than desktop", () => {
    const body = "y".repeat(300);
    expect(hookCutoff(body, "mobile").hidden.length).toBeGreaterThan(
      hookCutoff(body, "desktop").hidden.length,
    );
  });

  test("visible + hidden always reconstruct the original exactly", () => {
    const body = "z".repeat(500);
    for (const vp of ["mobile", "desktop"] as const) {
      const r = hookCutoff(body, vp);
      expect(r.visible + r.hidden).toBe(body);
    }
  });
});

describe("line budget (the case a character count misses)", () => {
  test("a THREE-line hook is cut on mobile despite being far under 140 chars", () => {
    // 24 characters total — a pure character check would say "no cut".
    const body = "One line.\nTwo line.\nThree.";
    expect(body.length).toBeLessThan(HOOK_LIMITS.mobile.chars);
    const r = hookCutoff(body, "mobile");
    expect(r.reason).toBe("lines");
    expect(r.visible).toBe("One line.\nTwo line.");
    expect(r.hidden).toBe("\nThree.");
  });

  test("blank lines consume the allowance — paragraph breaks truncate early", () => {
    // "a\n\nb": line 1 = "a", line 2 = "" (the blank), so "b" is already past
    // mobile's 2-line budget.
    const r = hookCutoff("a\n\nb", "mobile");
    expect(r.reason).toBe("lines");
    expect(r.visible).toBe("a\n");
    expect(r.hidden).toBe("\nb");
  });

  test("desktop allows three lines where mobile allows two", () => {
    const body = "one\ntwo\nthree\nfour";
    expect(hookCutoff(body, "mobile").visible).toBe("one\ntwo");
    expect(hookCutoff(body, "desktop").visible).toBe("one\ntwo\nthree");
  });

  test("exactly at the line budget is NOT cut", () => {
    expect(hookCutoff("one\ntwo", "mobile").reason).toBe("none");
    expect(hookCutoff("one\ntwo\nthree", "desktop").reason).toBe("none");
  });
});

describe("whichever limit comes first wins", () => {
  test("a long FIRST line hits the character budget before the line budget", () => {
    const body = `${"w".repeat(300)}\nsecond`;
    const r = hookCutoff(body, "mobile");
    expect(r.reason).toBe("chars");
    expect(r.index).toBe(140);
  });

  test("many short lines hit the line budget before the character budget", () => {
    const body = "a\nb\nc\nd\ne";
    const r = hookCutoff(body, "mobile");
    expect(r.reason).toBe("lines");
    expect(r.index).toBeLessThan(HOOK_LIMITS.mobile.chars);
  });
});

describe("hookCutoffHint", () => {
  test("returns null when nothing is hidden", () => {
    expect(hookCutoffHint("tiny", "mobile")).toBeNull();
  });

  test("names line breaks as the cause when the line budget bit", () => {
    const hint = hookCutoffHint("a\nb\nc", "mobile");
    expect(hint).toContain("line breaks count");
  });

  test("names the character limit when that bit first", () => {
    expect(hookCutoffHint("q".repeat(400), "mobile")).toContain("140 characters");
  });
});

describe("edge cases", () => {
  test("an empty body is never cut", () => {
    const r = hookCutoff("", "mobile");
    expect(r.reason).toBe("none");
    expect(r.visible).toBe("");
  });

  test("a body exactly at the character limit is not cut", () => {
    const body = "c".repeat(HOOK_LIMITS.mobile.chars);
    expect(hookCutoff(body, "mobile").reason).toBe("none");
  });

  test("one character over the limit IS cut", () => {
    const body = "c".repeat(HOOK_LIMITS.mobile.chars + 1);
    expect(hookCutoff(body, "mobile").reason).toBe("chars");
  });
});

// --- the rendered marker ---------------------------------------------------

describe("HookCutoffPreview rendering", () => {
  const render = (body: string, viewport: "mobile" | "desktop" = "mobile") =>
    renderToStaticMarkup(
      createElement(HookCutoffPreview, { body, viewport }),
    );

  test("draws the '…see more' rule and dims the hidden remainder", () => {
    const html = render(`${"a".repeat(200)} HIDDEN-TAIL`);
    expect(html).toContain("…see more");
    expect(html).toContain("border-dashed");
    expect(html).toContain("HIDDEN-TAIL"); // dimmed, never dropped
  });

  test("a short post shows no rule at all (it is a tip, not a warning)", () => {
    const html = render("Short hook.");
    expect(html).not.toContain("…see more");
    expect(html).not.toContain("border-dashed");
    expect(html).toContain("Short hook.");
  });

  test("a multi-line hook under 140 chars STILL gets the rule", () => {
    // The whole point: line breaks trigger the cut before the char budget.
    const html = render("one\ntwo\nthree");
    expect(html).toContain("…see more");
  });
});
