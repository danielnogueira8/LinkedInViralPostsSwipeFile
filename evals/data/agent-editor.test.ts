import { describe, expect, test } from "vitest";
import { editDraftBody, editDraftBodySync } from "@/lib/agent/specialists/editor";
import { stripEmDashes } from "@/lib/agent/specialists/nets";
import { normalizePostBody } from "@/lib/post-body-normalize";

describe("editDraftBodySync — matches the inline nets the live paths replaced", () => {
  const samples = [
    "I shipped it — finally.",
    "Fast, cheap, easy.",
    "1.First item\nsecond line",
    "This is a long dense block that runs well past two hundred and twenty characters so that the paragraph splitter fires. It has several sentences. Each should get its own breath once the normalizer injects the blank lines between the sentence boundaries here.",
    "A clean short post.",
  ];

  test("post kind == normalizePostBody(stripEmDashes(x)) for every sample", () => {
    for (const s of samples) {
      expect(editDraftBodySync(s, "post").body).toBe(normalizePostBody(stripEmDashes(s)));
    }
  });

  test("hook kind == stripEmDashes(x) trailing-trimmed (no paragraph injection)", () => {
    for (const s of samples) {
      expect(editDraftBodySync(s, "hook").body).toBe(stripEmDashes(s).replace(/\s+$/, ""));
    }
  });

  test("defaults to post kind", () => {
    const s = samples[3];
    expect(editDraftBodySync(s).body).toBe(editDraftBodySync(s, "post").body);
  });

  test("never returns an empty body for non-empty input", () => {
    expect(editDraftBodySync("x", "post").body).toBe("x");
    expect(editDraftBodySync("x", "hook").body).toBe("x");
  });
});

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

  test("a well-formed numbered list is left untouched", () => {
    // The list-heading/number repair nets were removed (the live writer model
    // formats lists correctly on its own — see lib/post-body-normalize.ts).
    // A numbered list with any newline is untouched by normalizePostBody's
    // remaining dense-block-only fallback.
    const body = "1. First\n2. Second\n3. Third";
    expect(normalizePostBody(body)).toBe(body);
  });

  test("dense block ending in a trailing newline → dense_paragraph still reported", async () => {
    // Regression: the old !/\n/.test(deAshed) guard false-negatived when the
    // input had a single trailing newline, even though the split DID fire.
    const dense =
      "This first idea runs long enough to matter in a real post about pricing strategy. " +
      "This second idea also needs its own breath and carries genuine length to it. " +
      "This third idea closes the block out with enough words to clear the split bar.\n";
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

  test("routes a three-short-sentence paragraph through rule-of-three repair", async () => {
    const r = await editDraftBody("And it's over. No trophy. No semifinal.");
    expect(r.notes.join(" ")).toContain("rule_of_three");
  });

  test("routes 'That's the whole point' through fake-polish repair", async () => {
    const r = await editDraftBody("That's the whole point.");
    expect(r.notes.join(" ")).toContain("fake_polish");
  });

  test("routes imported faux-insight setups through fake-polish repair", async () => {
    const r = await editDraftBody("The part everyone misses: distribution is the moat.");
    expect(r.notes.join(" ")).toContain("fake_polish");
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

  test("fails closed when the authoritative usage ledger throws", async () => {
    const error = new Error("usage insert unavailable");
    error.name = "UsagePersistenceError";
    await expect(
      editDraftBody("Fast, cheap, easy.", {
        useModel: true,
        modelRewrite: async () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
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
