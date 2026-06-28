import { describe, test, expect } from "vitest";
import { isValidElement, type ReactNode } from "react";
import { renderRichText, renderInline } from "@/app/(app)/dashboard/chat-workspace";

// ---------------------------------------------------------------------------
// Unit tests for the chat rich-text renderer — specifically the chat-only list
// support and the draft-mode regression guard.
//
// renderRichText returns React NODES (never HTML), so we introspect the element
// tree directly — no DOM needed, runs in the default hermetic suite. We assert
// on element `type` ("ul"/"ol"/"li"/"blockquote"/"span") and recover the text.
// ---------------------------------------------------------------------------

type El = { type: unknown; props: { children?: ReactNode; className?: string } };

function isEl(n: unknown): n is El {
  return isValidElement(n);
}

// Flatten any node tree to its concatenated text content. Takes `unknown` so it
// can recurse into our local `El` shape as well as plain ReactNodes.
function textOf(node: unknown): string {
  if (node == null || node === false || node === true) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isEl(node)) return textOf(node.props.children ?? null);
  return "";
}

// Collect every element of a given type ("ul", "ol", "li", "blockquote") in the tree.
function elementsOfType(node: unknown, type: string): El[] {
  const out: El[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (isEl(n)) {
      if (n.type === type) out.push(n);
      walk(n.props.children ?? null);
    }
  };
  walk(node);
  return out;
}

describe("renderRichText — draft mode (default) leaves post text literal", () => {
  // The load-bearing regression guard: a real LinkedIn post body must render
  // its "- " / "1." / "---" lines as literal text, never as lists/dividers.
  test("a dash-led post body is NOT turned into a <ul>", () => {
    const post = "Here's my framework:\n- Hire slow\n- Fire fast\n- Pay well";
    const out = renderRichText(post); // default "draft"
    expect(elementsOfType(out, "ul")).toHaveLength(0);
    expect(elementsOfType(out, "ol")).toHaveLength(0);
    // The literal dashes survive in the text.
    expect(textOf(out)).toContain("- Hire slow");
  });

  test("a numbered post body is NOT turned into an <ol>", () => {
    const out = renderRichText("Steps:\n1. Ship it\n2. Get feedback");
    expect(elementsOfType(out, "ol")).toHaveLength(0);
    expect(textOf(out)).toContain("1. Ship it");
  });

  test('explicit "draft" mode behaves identically to the default', () => {
    const post = "- a\n- b";
    expect(elementsOfType(renderRichText(post, "draft"), "ul")).toHaveLength(0);
  });

  test("blockquotes still render in draft mode (unchanged legacy behavior)", () => {
    const out = renderRichText("> a quoted line\n> second line");
    expect(elementsOfType(out, "blockquote")).toHaveLength(1);
  });
});

describe("renderRichText — chat mode renders lists", () => {
  test("contiguous dash lines → one <ul> with the right items", () => {
    const out = renderRichText("Patterns:\n- One\n- Two\n- Three\n", "chat");
    const uls = elementsOfType(out, "ul");
    expect(uls).toHaveLength(1);
    expect(elementsOfType(out, "li")).toHaveLength(3);
    expect(textOf(uls[0])).toContain("One");
    expect(textOf(uls[0])).toContain("Three");
  });

  test("numbered lines → one <ol>, rendering the model's literal numbers", () => {
    const out = renderRichText("Angles:\n1. First\n2. Second\n3. Third\n", "chat");
    const ols = elementsOfType(out, "ol");
    expect(ols).toHaveLength(1);
    expect(elementsOfType(out, "li")).toHaveLength(3);
    // Literal numbers are rendered (not a CSS counter), so they survive in text.
    const t = textOf(ols[0]);
    expect(t).toContain("1.");
    expect(t).toContain("3.");
  });

  test("•/* markers also produce an unordered list", () => {
    expect(elementsOfType(renderRichText("• a\n• b\n", "chat"), "ul")).toHaveLength(1);
    expect(elementsOfType(renderRichText("* a\n* b\n", "chat"), "ul")).toHaveLength(1);
  });

  test("inline bold/italic still work inside list items", () => {
    const out = renderRichText("- **bold** point\n- plain point\n", "chat");
    expect(elementsOfType(out, "strong")).toHaveLength(1);
  });

  test("a single dash line is NOT a list (needs 2+ parallel items by intent, but 1 still ok as a list of one)", () => {
    // One completed item still forms a (one-item) list — that's fine; the
    // "don't bullet a single point" rule is a PROMPT guideline, not a renderer
    // constraint. The renderer just must not crash or mis-handle it.
    const out = renderRichText("- only one\n", "chat");
    expect(() => textOf(out)).not.toThrow();
  });

  test("blockquoted list text is NOT re-styled as the assistant's own list", () => {
    // A quoted post line starting with "- " stays inside the blockquote.
    const out = renderRichText("> - their bullet\n> - another", "chat");
    expect(elementsOfType(out, "blockquote")).toHaveLength(1);
    expect(elementsOfType(out, "ul")).toHaveLength(0);
  });

  test("plain chat prose with no markers renders without lists (fast path)", () => {
    const out = renderRichText("Just a normal sentence, nothing special here.", "chat");
    expect(elementsOfType(out, "ul")).toHaveLength(0);
    expect(elementsOfType(out, "ol")).toHaveLength(0);
    expect(textOf(out)).toBe("Just a normal sentence, nothing special here.");
  });
});

describe("renderRichText — streaming safety (chat mode)", () => {
  // The last line of the buffer may still be arriving, so an in-progress list
  // line is NOT promoted until a newline proves it's complete.
  test("an in-progress final item stays plain until its newline arrives", () => {
    // No trailing newline → the "- Two" line is the last (incomplete) line.
    const mid = renderRichText("Items:\n- One\n- Tw", "chat");
    // "- One" is complete (followed by a newline) so a list exists with 1 item;
    // "- Tw" is the streaming tail and stays plain text.
    expect(elementsOfType(mid, "li").length).toBe(1);
    expect(textOf(mid)).toContain("- Tw"); // tail rendered literally
  });

  test("every prefix of a list-bearing reply renders without throwing", () => {
    const full = "Here are 3 angles:\n1. Lead with a metric\n2. Name a competitor\n3. Cite a hiring signal\nWant me to draft one?";
    for (let n = 1; n <= full.length; n++) {
      const prefix = full.slice(0, n);
      expect(() => renderRichText(prefix, "chat")).not.toThrow();
    }
  });

  test("the completed list snaps in once the buffer is finished", () => {
    const done = renderRichText("Items:\n- One\n- Two\n", "chat");
    expect(elementsOfType(done, "li")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Real agent output: the "5 post ideas" shape that caused a content-loss bug.
// Each idea is a bold/numbered title + "- *Angle:*" / "- *Hook style:*" italic
// lines, ending with a closing question. The renderer must keep EVERY item.
// ---------------------------------------------------------------------------

describe("renderRichText — the real 5-ideas reply shape", () => {
  const IDEAS = [
    "Here are 5 post ideas:",
    "",
    '**1. "Cold outreach is dead" — your take**',
    "- *Angle:* Why the playbook everyone copied stopped working.",
    "- *Hook style:* Contrarian — \"Everyone says cold outreach is dead.\"",
    "",
    '**2. A numbers-driven DM experiment**',
    "- *Angle:* What 500 voice notes revealed about reply rates.",
    "- *Hook style:* Result-first — \"I sent 500 DMs in 30 days.\"",
    "",
    '**5. "Your best post isn\'t the viral one"**',
    "- *Angle:* The post that books a call beats 2,000 likes.",
    "- *Hook style:* Pattern interrupt.",
    "",
    "Want me to draft any of these into a full post?",
  ].join("\n");

  test("renders without throwing and preserves every idea's title + closing line", () => {
    const out = renderRichText(IDEAS, "chat");
    const text = textOf(out);
    expect(text).toContain("Cold outreach is dead");
    expect(text).toContain("A numbers-driven DM experiment");
    expect(text).toContain("Your best post isn't the viral one");
    expect(text).toContain("Want me to draft any of these");
  });

  test("the bold idea titles render as <strong>", () => {
    const out = renderRichText(IDEAS, "chat");
    const strongs = elementsOfType(out, "strong").map(textOf);
    expect(strongs.some((s) => s.includes("Cold outreach is dead"))).toBe(true);
    expect(strongs.some((s) => s.includes("numbers-driven DM experiment"))).toBe(true);
  });

  test("the *Angle:* / *Hook style:* labels render as <em> inside list items", () => {
    const out = renderRichText(IDEAS, "chat");
    const ems = elementsOfType(out, "em").map(textOf);
    expect(ems.some((e) => e.startsWith("Angle:"))).toBe(true);
    expect(ems.some((e) => e.startsWith("Hook style:"))).toBe(true);
    // The "- " angle/hook lines become list items.
    expect(elementsOfType(out, "li").length).toBeGreaterThanOrEqual(4);
  });
});

describe("renderInline — bold/italic marker edge cases", () => {
  test("**bold** → one <strong>", () => {
    const out = renderInline("a **bold** b");
    expect(elementsOfType(out, "strong").map(textOf)).toEqual(["bold"]);
  });

  test("*italic* → one <em>", () => {
    const out = renderInline("a *italic* b");
    expect(elementsOfType(out, "em").map(textOf)).toEqual(["italic"]);
  });

  test("a bold title followed by an italic label parse as separate elements", () => {
    // The exact 5-ideas atom: a bold then an italic on the same logical line.
    const out = renderInline("**Title** *Angle: x*");
    expect(elementsOfType(out, "strong").map(textOf)).toEqual(["Title"]);
    expect(elementsOfType(out, "em").map(textOf)).toEqual(["Angle: x"]);
  });

  test("snake_case is NOT mangled into italics (underscore word-boundary guard)", () => {
    const out = renderInline("use send_draft and file_name.ts");
    expect(elementsOfType(out, "em")).toHaveLength(0);
    expect(textOf(out)).toContain("send_draft");
    expect(textOf(out)).toContain("file_name.ts");
  });

  test("a lone unmatched asterisk in prose is left literal", () => {
    const out = renderInline("3 * 4 = 12 and a * b");
    expect(elementsOfType(out, "em")).toHaveLength(0);
    expect(textOf(out)).toContain("3 * 4 = 12");
  });

  test("__bold__ underscore form also works", () => {
    const out = renderInline("a __bold__ b");
    expect(elementsOfType(out, "strong").map(textOf)).toEqual(["bold"]);
  });

  test("plain text with no markers renders as its literal text (no strong/em)", () => {
    const out = renderInline("just plain words");
    expect(elementsOfType(out, "strong")).toHaveLength(0);
    expect(elementsOfType(out, "em")).toHaveLength(0);
    expect(textOf(out)).toBe("just plain words");
  });
});
