import { describe, expect, test } from "vitest";
import { editDraftBody } from "@/lib/agent/specialists/editor";

describe("AI-Tell Editor — deterministic (model off)", () => {
  test("strips an em dash and reports em_dash", async () => {
    const r = await editDraftBody("I shipped it — finally.");
    expect(r.body).toBe("I shipped it, finally.");
    expect(r.changed).toBe(true);
    expect(r.usedModel).toBe(false);
    expect(r.fixedCategories).toContain("em_dash");
  });

  test("injects paragraph breaks into a dense block and reports dense_paragraph", async () => {
    // Must exceed normalizePostBody's 220-char threshold for splitting to fire —
    // short blocks are intentionally left alone.
    const dense =
      "This is the first idea that runs long enough to matter in a real LinkedIn post. This is the second idea that also needs its own breath and some genuine length. This is the third idea closing the block out nicely with enough words to clear the bar.";
    expect(dense.length).toBeGreaterThan(220);
    const r = await editDraftBody(dense);
    expect(r.body).toContain("\n\n");
    expect(r.fixedCategories).toContain("dense_paragraph");
  });

  test("clean input is unchanged and reports nothing fixed", async () => {
    const clean = "A single clean line.\n\nA second clean paragraph.";
    const r = await editDraftBody(clean);
    expect(r.body).toBe(clean);
    expect(r.changed).toBe(false);
    expect(r.fixedCategories).toEqual([]);
  });

  test("reports an unsafe rule-of-three in notes but does NOT rewrite it", async () => {
    const r = await editDraftBody("Fast, cheap, easy.");
    // Deterministic pass leaves the cadence intact (rewriting is unsafe).
    expect(r.body).toBe("Fast, cheap, easy.");
    expect(r.usedModel).toBe(false);
    expect(r.notes.join(" ")).toContain("rule_of_three");
  });
});

describe("AI-Tell Editor — optional model rewrite", () => {
  test("does not call the model when disabled, even with unsafe tells", async () => {
    let called = false;
    const r = await editDraftBody("Fast, cheap, easy.", {
      useModel: false,
      modelRewrite: async () => {
        called = true;
        return "rewritten";
      },
    });
    expect(called).toBe(false);
    expect(r.usedModel).toBe(false);
  });

  test("applies a good model rewrite and re-cleans its output", async () => {
    const r = await editDraftBody("Fast, cheap, easy.", {
      useModel: true,
      // Model returns a longer rewrite that (naughtily) contains an em dash;
      // the editor must re-strip it.
      modelRewrite: async () => "It is quick to run — cheap to keep, and simple to use in practice.",
    });
    expect(r.usedModel).toBe(true);
    expect(r.body).not.toContain("—");
    expect(r.fixedCategories).toContain("rule_of_three");
  });

  test("fails open on an empty/too-short model rewrite (keeps deterministic body)", async () => {
    const original = "Fast, cheap, easy.";
    const r = await editDraftBody(original, {
      useModel: true,
      modelRewrite: async () => "hi", // far too short → rejected
    });
    expect(r.usedModel).toBe(false);
    expect(r.body).toBe(original);
  });

  test("fails open when the model throws", async () => {
    const original = "Fast, cheap, easy.";
    const r = await editDraftBody(original, {
      useModel: true,
      modelRewrite: async () => {
        throw new Error("transport down");
      },
    });
    expect(r.usedModel).toBe(false);
    expect(r.body).toBe(original);
  });

  test("does not call the model when there are no unsafe tells", async () => {
    let called = false;
    await editDraftBody("A perfectly clean, ordinary sentence about pricing.", {
      useModel: true,
      modelRewrite: async () => {
        called = true;
        return "x".repeat(200);
      },
    });
    expect(called).toBe(false);
  });
});
