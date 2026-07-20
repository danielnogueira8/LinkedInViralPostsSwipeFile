import { describe, expect, test, vi } from "vitest";
import { editDraftBodySync } from "@/lib/agent/specialists/editor";
import {
  createDraftFinalizer,
  type DraftFinalizerSpecialists,
} from "@/lib/agent/finalize/finalizer";
import { voiceResultKeepsEmDashes } from "@/lib/agent/tools";
import {
  EM_DASH_KEEP_THRESHOLD,
  MIN_CONFIDENT_SAMPLES,
  mechanicsFingerprintToRules,
  mechanicsMatchScore,
  voiceKeepsEmDashes,
  type MechanicsFingerprint,
} from "@/lib/voice-mechanics";

// ---------------------------------------------------------------------------
// PR 3 of the voice-mechanics work: voice-aware nets + the fidelity scorer.
// The stripEmDashes anti-slop net ran on EVERY draft because em dashes are an
// AI tell — but for a user whose measured fingerprint shows they genuinely
// write with em dashes, stripping them made drafts LESS like the user. The
// net now backs off for exactly those writers, and mechanicsMatchScore gives
// evals a measurable "does this draft write like this person" number.
// ---------------------------------------------------------------------------

const baseFp: MechanicsFingerprint = {
  lowercase_sentence_starts: 0,
  lowercase_pronoun_i: 0,
  all_caps_word_rate: 0,
  em_dash_per_100_words: 0,
  ellipsis_per_100_words: 0,
  exclamation_per_100_words: 0,
  comma_splice_rate: 0,
  emoji_per_post: 0,
  emoji_placement: "none",
  median_sentences_per_paragraph: 2,
  uses_lists_rate: 0,
  dominant_list_marker: null,
  median_words_per_post: 120,
  sample_size: MIN_CONFIDENT_SAMPLES,
};

describe("voiceKeepsEmDashes", () => {
  test("true only on a confident fingerprint at/above the threshold", () => {
    expect(
      voiceKeepsEmDashes({ ...baseFp, em_dash_per_100_words: EM_DASH_KEEP_THRESHOLD }),
    ).toBe(true);
    expect(
      voiceKeepsEmDashes({ ...baseFp, em_dash_per_100_words: EM_DASH_KEEP_THRESHOLD - 0.01 }),
    ).toBe(false);
    expect(voiceKeepsEmDashes(null)).toBe(false);
    expect(voiceKeepsEmDashes(undefined)).toBe(false);
  });

  test("a thin sample never keeps em dashes, whatever the rate", () => {
    expect(
      voiceKeepsEmDashes({
        ...baseFp,
        em_dash_per_100_words: 5,
        sample_size: MIN_CONFIDENT_SAMPLES - 1,
      }),
    ).toBe(false);
  });

  test("the rule renderer and the net share the same threshold — never disagree", () => {
    const keeper: MechanicsFingerprint = {
      ...baseFp,
      em_dash_per_100_words: EM_DASH_KEEP_THRESHOLD,
    };
    expect(voiceKeepsEmDashes(keeper)).toBe(true);
    expect(
      mechanicsFingerprintToRules(keeper).some((r) => /keep them/i.test(r)),
    ).toBe(true);
  });
});

describe("editDraftBodySync — voice-aware em-dash handling", () => {
  const bodyWithDashes =
    "I started this company — against everyone's advice — and it worked.\n\nThe results speak for themselves.";

  test("default behavior unchanged: em dashes are stripped", () => {
    const { body } = editDraftBodySync(bodyWithDashes, "post");
    expect(body).not.toContain("—");
  });

  test("keepEmDashes: true preserves the writer's em dashes", () => {
    const { body, fixedCategories } = editDraftBodySync(bodyWithDashes, "post", {
      keepEmDashes: true,
    });
    expect(body).toContain("— against everyone's advice —");
    expect(fixedCategories).not.toContain("em_dash");
  });

  test("keepEmDashes still applies the other nets (paragraph normalization runs)", () => {
    // A dense 5-sentence single block still gets the dense-paragraph treatment
    // even when em dashes are kept — keepEmDashes disables ONLY the dash strip.
    const dense =
      "First sentence here with some length to it. Second sentence follows right after. Third one keeps the block going strong. Fourth sentence adds more heft to it. Fifth sentence closes out the dense block.";
    const kept = editDraftBodySync(dense, "post", { keepEmDashes: true });
    const stripped = editDraftBodySync(dense, "post");
    expect(kept.body).toBe(stripped.body); // no dashes present → identical output
  });

  test("hook kind honors keepEmDashes too", () => {
    const hook = "One decision — one outcome";
    expect(editDraftBodySync(hook, "hook").body).not.toContain("—");
    expect(
      editDraftBodySync(hook, "hook", { keepEmDashes: true }).body,
    ).toContain("—");
  });
});

describe("voiceResultKeepsEmDashes — reading the get_voice flag", () => {
  test("true only for an ok result with voice.keep_em_dashes === true", () => {
    expect(
      voiceResultKeepsEmDashes({ ok: true, voice: { keep_em_dashes: true } }),
    ).toBe(true);
    expect(
      voiceResultKeepsEmDashes({ ok: true, voice: {} }),
    ).toBe(false);
    expect(
      voiceResultKeepsEmDashes({ ok: false, voice: { keep_em_dashes: true } }),
    ).toBe(false);
    expect(voiceResultKeepsEmDashes(null)).toBe(false);
    expect(voiceResultKeepsEmDashes(undefined)).toBe(false);
    expect(voiceResultKeepsEmDashes({ ok: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Finalizer wiring: editOptions reach the real editor, and the by-reference
// contract works (the chat loop mutates the object after a mid-turn
// get_voice; later finalize calls must see the current value).
// ---------------------------------------------------------------------------

const DASHED_POST = [
  "Most LinkedIn posts do not fail because the writing is bad — they fail earlier.",
  "",
  "They fail because the writer starts before deciding what they actually believe.",
  "",
  "A useful post makes one honest claim — earns it with a concrete explanation — and leaves the reader with a decision they can use.",
  "",
  "That is what makes an idea worth publishing.",
].join("\n");

// Real editor, no-op model specialists — so the em-dash behavior under test
// is the genuine editDraftBodySync path, not a stub.
function realEditSpecialists(): Partial<DraftFinalizerSpecialists> {
  return {
    repairAiTells: vi.fn(async ({ body }) => ({
      body,
      repaired: false,
      detected: [],
    })),
    checkSameness: vi.fn(async ({ body }) => ({
      body,
      rewrote: false,
      overlapMarkers: [],
      reason: "",
    })),
    reviewSourceFidelity: vi.fn(async () => ({
      outcome: "verified" as const,
    })),
  };
}

describe("DraftFinalizer — editOptions wiring", () => {
  test("without editOptions the accepted draft has its em dashes stripped (default net)", async () => {
    const finalizer = createDraftFinalizer({
      workspaceId: "ws-1",
      priorDrafts: [],
      specialists: realEditSpecialists(),
    });
    const result = await finalizer.finalize({
      origin: "render_tool",
      body: DASHED_POST,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.body).not.toContain("—");
  });

  test("editOptions.keepEmDashes preserves the dashes in the accepted draft", async () => {
    const finalizer = createDraftFinalizer({
      workspaceId: "ws-1",
      priorDrafts: [],
      specialists: realEditSpecialists(),
      editOptions: { keepEmDashes: true },
    });
    const result = await finalizer.finalize({
      origin: "render_tool",
      body: DASHED_POST,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.body).toContain("—");
  });

  test("editOptions is read BY REFERENCE — a post-creation mutation applies to later finalize calls", async () => {
    const editOptions = { keepEmDashes: false };
    const finalizer = createDraftFinalizer({
      workspaceId: "ws-1",
      priorDrafts: [],
      specialists: realEditSpecialists(),
      editOptions,
    });
    // Simulates the chat loop flipping the flag when a mid-turn get_voice
    // reveals the writer genuinely uses em dashes.
    editOptions.keepEmDashes = true;
    const result = await finalizer.finalize({
      origin: "render_tool",
      body: DASHED_POST,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.body).toContain("—");
  });

  test("keepEmDashes is forwarded to the repairAiTells specialist", async () => {
    const specialists = realEditSpecialists();
    const finalizer = createDraftFinalizer({
      workspaceId: "ws-1",
      priorDrafts: [],
      specialists,
      editOptions: { keepEmDashes: true },
    });
    await finalizer.finalize({ origin: "render_tool", body: DASHED_POST });
    expect(specialists.repairAiTells).toHaveBeenCalledWith(
      expect.objectContaining({ keepEmDashes: true }),
    );
  });
});

// ---------------------------------------------------------------------------
// mechanicsMatchScore — the measurable voice-fidelity signal for evals.
// ---------------------------------------------------------------------------

describe("mechanicsMatchScore", () => {
  test("null score when the user fingerprint is below the confidence floor", () => {
    const fp = { ...baseFp, sample_size: MIN_CONFIDENT_SAMPLES - 1 };
    expect(mechanicsMatchScore("Some draft body.", fp).score).toBeNull();
  });

  test("null score when the user has no strong habits to check", () => {
    // Every signal sits in the unscoreable middle: mixed casing, some em
    // dashes, some exclamations, mid emoji rate, multi-sentence paragraphs.
    const mixed: MechanicsFingerprint = {
      ...baseFp,
      lowercase_sentence_starts: 0.3,
      em_dash_per_100_words: 0.1,
      exclamation_per_100_words: 0.5,
      emoji_per_post: 0.3,
      median_sentences_per_paragraph: 3,
    };
    expect(mechanicsMatchScore("Some draft body.", mixed).score).toBeNull();
  });

  test("a lowercase writer scores a lowercase draft high and a capitalized draft low", () => {
    const lowercaseWriter: MechanicsFingerprint = {
      ...baseFp,
      lowercase_sentence_starts: 0.9,
      lowercase_pronoun_i: 0.9,
      median_sentences_per_paragraph: 3, // neutral — keep this check out
    };
    const matching = mechanicsMatchScore(
      "this is how i write. always lowercase. i never break the habit.",
      lowercaseWriter,
    );
    const clashing = mechanicsMatchScore(
      "This is a properly capitalized draft. I follow standard grammar here.",
      lowercaseWriter,
    );
    expect(matching.score).toBe(1);
    // The clashing draft still passes the incidental no-dash/no-emoji checks
    // (it genuinely has none) — the point is the CASING checks fail and drag
    // the score down.
    expect(clashing.score).toBeLessThan(matching.score!);
    expect(
      clashing.checks.find((c) => c.signal === "lowercase_sentence_starts")!.pass,
    ).toBe(false);
    expect(
      clashing.checks.find((c) => c.signal === "lowercase_pronoun_i")!.pass,
    ).toBe(false);
  });

  test("a no-em-dash writer's draft fails the check when the draft uses them", () => {
    const noDashes: MechanicsFingerprint = {
      ...baseFp,
      lowercase_sentence_starts: 0, // strong: always capitalizes
      median_sentences_per_paragraph: 3,
    };
    const result = mechanicsMatchScore(
      "This draft — unlike the writer — leans on em dashes. It should not.",
      noDashes,
    );
    const dashCheck = result.checks.find((c) => c.signal === "no_em_dashes");
    expect(dashCheck).toBeDefined();
    expect(dashCheck!.pass).toBe(false);
  });

  test("the list-marker check only fires when the draft actually contains a list", () => {
    const arrowLister: MechanicsFingerprint = {
      ...baseFp,
      uses_lists_rate: 0.6,
      dominant_list_marker: "→",
      median_sentences_per_paragraph: 3,
    };
    const noList = mechanicsMatchScore("Just prose, no list at all here.", arrowLister);
    expect(noList.checks.find((c) => c.signal === "list_marker")).toBeUndefined();

    const wrongMarker = mechanicsMatchScore(
      "The plan:\n- ship it\n- measure it",
      arrowLister,
    );
    const check = wrongMarker.checks.find((c) => c.signal === "list_marker");
    expect(check).toBeDefined();
    expect(check!.pass).toBe(false);

    const rightMarker = mechanicsMatchScore(
      "The plan:\n→ ship it\n→ measure it",
      arrowLister,
    );
    expect(
      rightMarker.checks.find((c) => c.signal === "list_marker")!.pass,
    ).toBe(true);
  });

  test("an emoji-using writer's draft with zero emoji fails the uses_emoji check", () => {
    const emojiWriter: MechanicsFingerprint = {
      ...baseFp,
      emoji_per_post: 1.5,
      emoji_placement: "end",
      median_sentences_per_paragraph: 3,
      lowercase_sentence_starts: 0.3, // neutral
      em_dash_per_100_words: 0.1, // neutral
      exclamation_per_100_words: 0.5, // neutral
    };
    const result = mechanicsMatchScore("No emoji anywhere in this draft.", emojiWriter);
    const check = result.checks.find((c) => c.signal === "uses_emoji");
    expect(check).toBeDefined();
    expect(check!.pass).toBe(false);
  });
});
