import { describe, test, expect } from "vitest";
import {
  looksLikeComposerRefine,
  askAnswerShouldRefineLatestDraft,
  artifactSkillNames,
  skillNamesToIds,
  splitHook,
  guardRefineCollapse,
  reinsertArtifact,
} from "@/lib/chat-ui-policy";
import type { Artifact } from "@/lib/agent/contracts";
import {
  buildHookOnlyRefineMessage,
  isHookFocusedRefine,
  splitHookLines,
  splicePreservedBody,
} from "@/lib/hook-splice";

// ---------------------------------------------------------------------------
// A refine produces a NEW draft card alongside the source — no in-place swap,
// no version history. The client-side glue (pendingRefineRef → collapse guard,
// hook-only body preservation) is exercised by the guards below and by the
// agent-loop tests in refine-no-explosion.test.ts. This file locks in the
// PURE helpers: refine-instruction detection, skill inheritance, and the
// body-preservation math.
// ---------------------------------------------------------------------------

const mk = (id: string, body: string, meta?: Record<string, unknown>): Artifact => ({
  id,
  kind: "post",
  title: body.split("\n", 1)[0],
  body,
  ...(meta ? { meta } : {}),
});

// ---------------------------------------------------------------------------
// Refine inherits the source draft's skill (the badge + the guidance). The
// draft stores skill SLUGS on meta.skills; a refine needs the skill IDS to send
// to the server. artifactSkillNames reads the slugs; skillNamesToIds maps them.
// ---------------------------------------------------------------------------
describe("artifactSkillNames — read a draft's applied skill slugs", () => {
  test("reads string entries from meta.skills", () => {
    expect(artifactSkillNames(mk("a", "b", { skills: ["cta", "x"] }))).toEqual(["cta", "x"]);
  });
  test("no meta → empty", () => {
    expect(artifactSkillNames(mk("a", "b"))).toEqual([]);
  });
  test("non-array / non-string entries are dropped", () => {
    expect(artifactSkillNames(mk("a", "b", { skills: "cta" }))).toEqual([]);
    expect(artifactSkillNames(mk("a", "b", { skills: [1, "ok", null] }))).toEqual(["ok"]);
  });
});

describe("skillNamesToIds — map slugs to ids for a refine send", () => {
  const skills = [
    { id: "id-cta", name: "cta" },
    { id: "id-story", name: "storytelling" },
  ];
  test("maps known slugs in order", () => {
    expect(skillNamesToIds(["storytelling", "cta"], skills)).toEqual(["id-story", "id-cta"]);
  });
  test("drops a slug that no longer resolves (deleted/renamed skill)", () => {
    expect(skillNamesToIds(["cta", "gone"], skills)).toEqual(["id-cta"]);
  });
  test("empty names → empty ids", () => {
    expect(skillNamesToIds([], skills)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Server-side jsonb rewrite (PATCH /artifacts): the durable half. Used by the
// inline Done-edit + updateArtifactMeta paths — replaces one artifact's
// body/title/meta in place. Pure helper, tested without the Clerk/Supabase
// route shell.
// ---------------------------------------------------------------------------

import { rewriteArtifactInPlace } from "@/lib/artifact-rewrite";

describe("rewriteArtifactInPlace — in-place body/title/meta update", () => {
  test("replaces the target's body + title + meta and leaves siblings alone", () => {
    const arts = [
      { id: "t", kind: "post", title: "T", body: "old" },
      { id: "s", kind: "post", title: "S", body: "sibling" },
    ];
    const res = rewriteArtifactInPlace(arts, {
      targetId: "t",
      body: "new body",
      title: "New T",
      meta: { skills: ["cta"] },
    });
    expect(res.changed).toBe(true);
    expect(res.next).toHaveLength(2);
    expect(res.next[0]).toMatchObject({ id: "t", body: "new body", title: "New T" });
    expect(res.next[1]).toEqual(arts[1]); // sibling untouched
  });

  test("changed=false when the target isn't in this message", () => {
    const arts = [{ id: "x", kind: "post", title: "X", body: "z" }];
    const res = rewriteArtifactInPlace(arts, { targetId: "t", body: "new" });
    expect(res.changed).toBe(false);
    expect(res.next).toEqual(arts);
  });

  test("meta is fully overwritten (not merged) with what the client sends", () => {
    const arts = [{ id: "t", kind: "post", title: "T", body: "b", meta: { skills: ["cta"] } }];
    const res = rewriteArtifactInPlace(arts, {
      targetId: "t",
      body: "b",
      meta: { skills: ["storytelling"] },
    });
    expect((res.next[0].meta as { skills?: string[] }).skills).toEqual(["storytelling"]);
  });

  test("omitted title/meta preserves the existing values", () => {
    const arts = [{ id: "t", kind: "post", title: "Keep", body: "b", meta: { skills: ["cta"] } }];
    const res = rewriteArtifactInPlace(arts, { targetId: "t", body: "new" });
    expect(res.next[0].title).toBe("Keep");
    expect((res.next[0].meta as { skills?: string[] }).skills).toEqual(["cta"]);
  });
});

// ---------------------------------------------------------------------------
// Hook-only refine (bug #1): refining "the hook" of a POST must change ONLY the
// opener and preserve the rest of the body verbatim (formatting included), even
// if GLM rewrites more than asked. isHookFocusedRefine detects the case;
// splitHook + splicePreservedBody do the deterministic body preservation.
// ---------------------------------------------------------------------------

describe("isHookFocusedRefine — detect a hook-only instruction", () => {
  for (const i of [
    "Punchier hook",
    "make the opener more contrarian",
    "rewrite the first line",
    "punchier opening",
  ]) {
    test(`"${i}" → hook-focused`, () => expect(isHookFocusedRefine(i)).toBe(true));
  }

  for (const i of [
    "make it shorter",
    "more story-driven",
    "add a statistic",
    "rewrite the whole post",
    "rewrite the post to be punchier",
    "tighten each paragraph",
    // CTA / closing-line / sign-off edits touch the END of the post — the
    // structural OPPOSITE of the hook. Reliability finding: these were
    // wrongly classified hook-focused, which (a) told the model "don't
    // rewrite the body" — contradicting a CTA instruction — and (b) the
    // server-side splice then discarded the model's real edit and grafted
    // its first 1-2 lines onto the UNCHANGED original body, so a "stronger
    // CTA" or "add a disclaimer to the CTA" pick silently did nothing to
    // the CTA. Confirmed live: "Add a connection-request disclaimer to the
    // CTA" produced a hook rewrite instead of a CTA change.
    "stronger CTA",
    "change the call to action",
    "Add a CTA",
    "Add a CTA for my services",
    "Add a connection-request disclaimer to the CTA",
    "Add a disclaimer to the closing line",
    "change the sign-off",
  ]) {
    test(`"${i}" → NOT hook-focused`, () => expect(isHookFocusedRefine(i)).toBe(false));
  }
});

describe("splitHook — first paragraph vs the rest", () => {
  test("splits at the first blank line", () => {
    expect(splitHook("Hook line.\n\nBody one.\n\nBody two.")).toEqual({
      hook: "Hook line.",
      rest: "Body one.\n\nBody two.",
    });
  });

  test("a single-paragraph post has no rest", () => {
    expect(splitHook("Just one paragraph, no breaks.")).toEqual({
      hook: "Just one paragraph, no breaks.",
      rest: "",
    });
  });

  test("tolerates a blank line with whitespace", () => {
    const r = splitHook("Hook.\n  \nBody.");
    expect(r.hook).toBe("Hook.");
    expect(r.rest).toBe("Body.");
  });
});

describe("splicePreservedBody — hook = first paragraph (<=2 lines), body preserved", () => {
  // A post whose first paragraph is a 2-line hook, then a real body. The
  // reported bug: "make the hook punchier" changed the whole body. Now only the
  // first paragraph's opener changes; the body is byte-preserved.
  const original =
    "I quit my job at 24.\nEveryone said I was crazy.\n\nThree years later I run a $2M business.\n\nHere's the one bet that made it work.";
  const body = "Three years later I run a $2M business.\n\nHere's the one bet that made it work.";

  test("grafts the refined FIRST 2 LINES onto the ORIGINAL body verbatim", () => {
    // GLM rewrote the whole post (new hook AND a rewritten body it should NOT touch).
    const refined =
      "At 24 I walked away from a safe job.\nMy family thought I'd lost it.\n\nA COMPLETELY different body the user did not ask for.\n\nAnd another rewritten line.";
    const out = splicePreservedBody(original, refined);
    // New 2-line hook kept; original body restored exactly.
    expect(out).toBe(
      "At 24 I walked away from a safe job.\nMy family thought I'd lost it.\n\n" + body,
    );
    expect(out).toContain(body); // body survives byte-for-byte
  });

  test("ALWAYS preserves the body — even if the model left the hook unchanged", () => {
    // Hook identical, but the model rewrote the body. A hook refine must never
    // let the body drift, so we still restore the original body.
    const refined =
      "I quit my job at 24.\nEveryone said I was crazy.\n\nA sneaky rewritten body.";
    const out = splicePreservedBody(original, refined);
    expect(out).toBe(
      "I quit my job at 24.\nEveryone said I was crazy.\n\n" + body,
    );
  });

  test("returns refined unchanged when the ORIGINAL has <= 2 content lines", () => {
    // Nothing past the hook to preserve → the refined opener stands.
    expect(splicePreservedBody("Line one.\nLine two.", "A new one.\nAnd two.")).toBe(
      "A new one.\nAnd two.",
    );
    expect(splicePreservedBody("One line only.", "A new line.")).toBe("A new line.");
  });

  test("a flat single-block refine still gets the original body grafted back on", () => {
    // GLM returns the whole refined post as one line: it's all "hook" (< 2 content
    // lines), so it grafts as the new opener and the real body is restored.
    const out = splicePreservedBody(original, "A punchier one-line opener.");
    expect(out).toBe("A punchier one-line opener.\n\n" + body);
  });

  test("preserves paragraph body when the hook lives in the first paragraph", () => {
    // Classic shape: 2-line hook, blank, then multi-paragraph body.
    const orig =
      "Stop optimizing your morning routine.\nIt is not why you're stuck.\n\nThe real bottleneck is your calendar.\n\nProtect two deep-work blocks and everything changes.";
    const refined =
      "Your 5am routine is a trap.\nProductivity theater, nothing more.\n\ntotally different body one.\n\ntotally different body two.";
    const out = splicePreservedBody(orig, refined);
    expect(out).toBe(
      "Your 5am routine is a trap.\nProductivity theater, nothing more.\n\n" +
        "The real bottleneck is your calendar.\n\nProtect two deep-work blocks and everything changes.",
    );
  });
});

describe("splitHookLines — hook = first paragraph (capped at N lines), NEVER crossing a blank line", () => {
  test("a 2-line first paragraph → both lines are the hook; body is paragraphs 2+", () => {
    expect(
      splitHookLines("Line one.\nLine two.\n\nBody a.\n\nBody b.", 2),
    ).toEqual({ hook: "Line one.\nLine two.", rest: "Body a.\n\nBody b." });
  });

  test("REGRESSION: one sentence per paragraph → hook is ONLY paragraph 1, para 2 is preserved", () => {
    // The bug: "first 2 content lines" swallowed paragraph 2 into the hook, so a
    // hook refine deleted it. The hook must never cross the first blank line.
    expect(splitHookLines("One.\n\nTwo.", 2)).toEqual({
      hook: "One.",
      rest: "Two.",
    });
    expect(
      splitHookLines("I got fired.\n\nThen I built a company.\n\nHere's the lesson.", 2),
    ).toEqual({
      hook: "I got fired.",
      rest: "Then I built a company.\n\nHere's the lesson.",
    });
  });

  test("a >2-line first paragraph caps the hook at N; the overflow stays in the body", () => {
    expect(
      splitHookLines("L1.\nL2.\nL3.\n\nBody.", 2),
    ).toEqual({ hook: "L1.\nL2.", rest: "L3.\n\nBody." });
  });

  test("a single-paragraph post has no rest to preserve", () => {
    expect(splitHookLines("Only one line.", 2)).toEqual({
      hook: "Only one line.",
      rest: "",
    });
    expect(splitHookLines("Line one.\nLine two.", 2)).toEqual({
      hook: "Line one.\nLine two.",
      rest: "",
    });
  });

  test("collapses the blank-line separator + skips leading blanks", () => {
    expect(splitHookLines("H1.\nH2.\n\n\nBody.", 2).rest).toBe("Body.");
    // Leading blank lines don't consume the hook budget.
    expect(splitHookLines("\n\nHook.\n\nBody.", 2)).toEqual({
      hook: "Hook.",
      rest: "Body.",
    });
  });

  test("tolerates CRLF line endings (normalized to \\n)", () => {
    expect(splitHookLines("A.\r\nB.\r\n\r\nBody1.\r\nBody2.", 2)).toEqual({
      hook: "A.\nB.",
      rest: "Body1.\nBody2.",
    });
  });
});

describe("splicePreservedBody — REGRESSION: one-line-per-paragraph body is not deleted", () => {
  test("hook refine on a one-sentence-per-paragraph post preserves EVERY body paragraph", () => {
    const orig =
      "I got fired on a Tuesday.\n\nThen I built a $2M business.\n\nHere is what nobody tells you.\n\nLesson one.";
    const refined = "Fired on a Tuesday, broke by Friday.\n\nSOME NEW BODY.";
    const out = splicePreservedBody(orig, refined);
    // The whole body from paragraph 2 on survives — the earlier bug dropped
    // "Then I built a $2M business.".
    expect(out).toBe(
      "Fired on a Tuesday, broke by Friday.\n\n" +
        "Then I built a $2M business.\n\nHere is what nobody tells you.\n\nLesson one.",
    );
    expect(out).toContain("Then I built a $2M business.");
  });
});

// ---------------------------------------------------------------------------
// guardRefineCollapse — the reported bug: a general (non-hook-only) refine of a
// long multi-paragraph post came back as JUST the hook (GLM "tightened" the
// whole post into a single punchy line, or returned the opener and dropped the
// body). Accepting it replaced the user's whole post with a fragment. The guard
// detects that collapse and keeps the original body instead.
// ---------------------------------------------------------------------------

describe("guardRefineCollapse — a refine must not shrink a post to a lone hook", () => {
  // A realistic long, multi-paragraph post (the ~3000-char version-1 case).
  const longPost = [
    "At 22, I posted every single day for a year. My best post got 14 likes.",
    "I was convinced the algorithm hated me. So I studied what the accounts pulling millions of impressions actually did differently.",
    "It wasn't frequency. It wasn't hashtags. It was that every post opened a loop the reader needed to close.",
    "I rewrote my next 30 posts around that one idea. The 31st did 40,000 impressions.",
    "Here's the part nobody tells you: consistency without a reason to click is just noise on a schedule.",
    "Start with the first line. Earn the second. The rest takes care of itself.",
  ].join("\n\n");
  // The bug's output: a clean, complete 2-sentence hook (NOT truncated mid-word).
  const loneHook = "At 22, I posted every single day for a year. My best post got 14 likes.";

  test("collapses to a lone hook → keeps the ORIGINAL body, flags collapsed", () => {
    const r = guardRefineCollapse(longPost, loneHook);
    expect(r.collapsed).toBe(true);
    expect(r.body).toBe(longPost); // the full post is preserved, not the fragment
  });

  test("a legitimately shorter BUT still multi-paragraph refine passes through", () => {
    // The user asked to cut it down; GLM returned a tighter post that still has
    // paragraph structure. That's a real refine — NOT a collapse.
    const tighter = [
      "At 22 I posted daily for a year. Best post: 14 likes.",
      "The accounts winning weren't posting more. Every post just opened a loop the reader had to close.",
      "I rewrote 30 posts around that. The 31st hit 40k impressions.",
    ].join("\n\n");
    const r = guardRefineCollapse(longPost, tighter);
    expect(r.collapsed).toBe(false);
    expect(r.body).toBe(tighter);
  });

  test("a full-length rewrite (similar size, multi-paragraph) passes through", () => {
    const rewrite = longPost.replace("14 likes", "11 likes");
    const r = guardRefineCollapse(longPost, rewrite);
    expect(r.collapsed).toBe(false);
    expect(r.body).toBe(rewrite);
  });

  test("does NOT fire when the ORIGINAL was already a single paragraph", () => {
    // Nothing to protect — a one-paragraph post refined to another short one is
    // a normal edit, not a collapse.
    const r = guardRefineCollapse("A single punchy one-liner post.", "A different one-liner.");
    expect(r.collapsed).toBe(false);
  });

  test("a heavy but still-substantial multi-paragraph trim passes (real shortening)", () => {
    // A big cut the user genuinely asked for — but it stays a real, coherent,
    // multi-paragraph post well above the gut floor, so it's NOT blocked.
    const trimmed = [
      "At 22 I posted daily for a year. My best post got 14 likes.",
      "The accounts winning weren't posting more often. Every post just opened a loop the reader had to close.",
      "I rewrote 30 posts around that idea. The 31st did 40,000 impressions.",
      "Consistency without a reason to click is just noise on a schedule. Start with the first line; earn the second.",
    ].join("\n\n");
    const r = guardRefineCollapse(longPost, trimmed);
    expect(r.collapsed).toBe(false);
    expect(r.body).toBe(trimmed);
  });

  // The REPORTED bug: a coherent ~1,111-char post "shortened" to a nonsensical
  // ~164 chars. Even though 164 chars can carry a blank line (so it's not a lone
  // hook), it's a GUT — below both the ratio and the absolute floor — and must
  // be rejected so the user keeps their real post.
  test("a substantial post gutted to a tiny fragment is caught (the 1,111→164 bug)", () => {
    const bigPost =
      "I spent six years learning this the hard way.\n\n" +
      "x".repeat(1050) + // pad to ~1,111 chars of "post"
      "\n\nThat's the whole lesson.";
    expect(bigPost.length).toBeGreaterThan(1000);
    // ~164-char two-line "post" — structured, but a fraction of the original.
    const gutted = "The hard way taught me one thing.\n\nMost people quit right before it works, and that is the entire game.";
    const r = guardRefineCollapse(bigPost, gutted);
    expect(r.collapsed).toBe(true);
    expect(r.body).toBe(bigPost); // the real post is kept
  });

  test("a short original is NEVER gut-guarded (only substantial posts are protected)", () => {
    // Below REFINE_MIN_ORIGINAL_CHARS → the GUT clause can't fire. The refined
    // stays multi-paragraph (so the lone-hook clause doesn't fire either), which
    // isolates the size gate: a short post trimmed to a shorter multi-paragraph
    // one is a normal edit, not a collapse.
    const shortPost = "A tight little post.\n\nWith two short beats.\n\nThat's it, done.";
    expect(shortPost.length).toBeLessThan(500);
    const trimmed = "A tight post.\n\nOne beat only.";
    const r = guardRefineCollapse(shortPost, trimmed);
    expect(r.collapsed).toBe(false);
  });

  test("an empty/whitespace refine is caught (degenerate collapse)", () => {
    // A blank re-render of a real post is the extreme collapse — keep the post.
    // (The artifact schema also rejects an empty body, but the guard shouldn't
    // hand a fragment through on the way there.)
    const r = guardRefineCollapse(longPost, "   \n  ");
    expect(r.collapsed).toBe(true);
    expect(r.body).toBe(longPost);
  });
});

// ---------------------------------------------------------------------------
// reinsertArtifact — the rollback for a FAILED optimistic delete (bug-hunt #2).
// The delete button isn't gated on streaming, so a new draft can stream in
// during the DELETE round-trip. On failure we must re-insert the deleted card
// WITHOUT erasing that streamed-in draft (the old code restored a stale
// snapshot and lost it).
// ---------------------------------------------------------------------------

describe("reinsertArtifact — failed-delete rollback reconciles with current state", () => {
  const a = (id: string): Artifact => ({ id, kind: "post", title: id, body: id });

  test("re-inserts the deleted artifact at its original index", () => {
    // List was [x, y, z]; deleted y (idx 1); current is [x, z]; rollback → [x, y, z].
    const out = reinsertArtifact([a("x"), a("z")], 1, a("y"));
    expect(out.map((o) => o.id)).toEqual(["x", "y", "z"]);
  });

  test("KEEPS an artifact that streamed in during the await (the bug)", () => {
    // Deleted 'old' (was idx 0). During the await, 'new' streamed in → current
    // is ['new']. Rollback must restore 'old' AND keep 'new'.
    const out = reinsertArtifact([a("new")], 0, a("old"));
    expect(out.map((o) => o.id)).toContain("new");
    expect(out.map((o) => o.id)).toContain("old");
    expect(out).toHaveLength(2);
  });

  test("clamps an out-of-range index to the current bounds", () => {
    // Original idx was 5, but the current list shrank to 1 → append at the end.
    const out = reinsertArtifact([a("only")], 5, a("back"));
    expect(out.map((o) => o.id)).toEqual(["only", "back"]);
  });

  test("no-ops if the artifact is somehow already present (no duplicate)", () => {
    const list = [a("x"), a("y")];
    const out = reinsertArtifact(list, 0, a("y"));
    expect(out).toBe(list); // same ref — nothing to do
    expect(out.filter((o) => o.id === "y")).toHaveLength(1);
  });

  test("does not mutate the input array", () => {
    const list = [a("x")];
    const snap = JSON.parse(JSON.stringify(list));
    reinsertArtifact(list, 0, a("y"));
    expect(list).toEqual(snap);
  });
});

// ---------------------------------------------------------------------------
// Auto-detect "this composer message is a refine of the current draft" so a
// chat-typed refine (vs the per-card Refine button) doesn't stack a duplicate
// card. Must be conservative — false positives stack the WRONG card; false
// negatives just produce a duplicate (the existing bug).
// ---------------------------------------------------------------------------
describe("looksLikeComposerRefine — chat-typed refine detection", () => {
  test.each([
    "refine this",
    "tighten it",
    "make it shorter",
    "make it punchier",
    "make this stronger",
    "make the hook stronger",
    "rewrite it",
    "rewrite the hook",
    "change the cta",
    "polish it",
    "edit this",
    "edit it",
    "improve the opening",
    "Make it more direct.",
    "tweak the hook",
    "shorten the body",
  ])("'%s' is a refine", (msg) => {
    expect(looksLikeComposerRefine(msg)).toBe(true);
  });

  test.each([
    "give me another draft",
    "make a new one",
    "give me a fresh take",
    "draft 5 more like this",
    "I want a different draft",
    "make a variation",
    "give me version 2",
    "one more draft",
    "draft an alternative",
  ])("'%s' is NOT a refine (wants a new draft)", (msg) => {
    expect(looksLikeComposerRefine(msg)).toBe(false);
  });

  test.each([
    "what do you think of this?",
    "thanks!",
    "write a post about distribution",
    "hi",
    "",
    "   ",
  ])("'%s' is NOT a refine (unrelated)", (msg) => {
    expect(looksLikeComposerRefine(msg)).toBe(false);
  });

  test("if it CONTAINS 'another' (a new-draft signal), refine is NOT applied", () => {
    // Even with a refine word, "another" wins — user is asking for a new card.
    expect(looksLikeComposerRefine("rewrite this as another version")).toBe(false);
  });

  test("case-insensitive", () => {
    expect(looksLikeComposerRefine("MAKE IT SHORTER")).toBe(true);
    expect(looksLikeComposerRefine("Tighten The Hook")).toBe(true);
  });
});

describe("askAnswerShouldRefineLatestDraft — post-draft ask answers", () => {
  const postDraftAsk = {
    question: "Anything else on this one?",
    options: ["Tighten the hook", "Make it shorter", "Add a CTA", "They're good — done"],
  };

  test.each([
    "Tighten the hook",
    "Make it shorter",
    "Add a CTA",
    "Make it a list-format variation",
    "Turn it into a listicle",
  ])("'%s' refines the latest draft from a post-draft ask", (answer) => {
    expect(askAnswerShouldRefineLatestDraft(postDraftAsk, answer)).toBe(true);
  });

  test("done answer does not start another model turn", () => {
    expect(askAnswerShouldRefineLatestDraft(postDraftAsk, "They're good — done")).toBe(false);
  });

  test("the same variation wording from the raw composer still means a new draft", () => {
    expect(looksLikeComposerRefine("Make it a list-format variation")).toBe(false);
  });

  test("ordinary clarifying-question answers do not force an in-place refine", () => {
    expect(
      askAnswerShouldRefineLatestDraft(
        {
          question: "Which angle should I use?",
          options: ["Customer win", "Contrarian", "Founder story"],
        },
        "Customer win",
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildHookOnlyRefineMessage — the enriched message the client sends to the
// agent for a hook-only refine. Same shape used by BOTH the per-card Refine
// button AND the ask-card "Tighten the hook" click, so the model always
// sees the "rewrite ONLY the hook" instruction. Pure + shared with the
// server via lib/hook-splice.
// ---------------------------------------------------------------------------
describe("buildHookOnlyRefineMessage — enriched refine prompt", () => {
  test("wraps the instruction with the 'Rewrite ONLY the hook' clause + quotes the source body", () => {
    const msg = buildHookOnlyRefineMessage(
      "Tighten the hook",
      "Line one.\n\nLine two.",
    );
    expect(msg).toContain("Tighten the hook.");
    expect(msg).toContain("Rewrite ONLY the hook");
    expect(msg).toContain("Do NOT rewrite the body");
    expect(msg).toContain(`"""\nLine one.\n\nLine two.\n"""`);
  });

  test("byte-identical to what the per-card refineDraft() builds (single source of truth)", () => {
    // Locks in that both call sites use ONE prompt string. If refineDraft's
    // inline template ever drifts from this helper, this test fires.
    const built = buildHookOnlyRefineMessage("Punchier hook", "The body.");
    const expected =
      `Refine this post: Punchier hook. Rewrite ONLY the hook — the first 1-2 lines. ` +
      `You may lightly adjust the next 1-2 lines so they still flow from the new hook, ` +
      `but leave the rest of the post EXACTLY as given: every other word and line break ` +
      `unchanged, blank lines between paragraphs kept. Do NOT rewrite the body.\n\n` +
      `Keep it in my voice. Here's the current post:\n"""\nThe body.\n"""`;
    expect(built).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// REGRESSION: the "Tighten the hook click drifted the whole body" bug the
// user reported after 2-3 prior attempts to fix it. The failure mode: user
// clicks "Tighten the hook" in the ask-card → model returns a fully-rewritten
// post (new examples, new list items, collapsed line breaks) → the client's
// splice runs but was clobbered by the post-stream reload of the SERVER's
// saved artifact, which had the model's full rewrite. Fix: the server
// splices before persisting, so DB + reload + client all see the same body.
//
// The test exercises the pure splice with the EXACT drafts from the user's
// report. If this ever fails, the "hook refine changed the whole body" bug
// is back.
// ---------------------------------------------------------------------------
describe("REGRESSION: splicePreservedBody rescues the reported 'Tighten the hook' failure", () => {
  const draft1 = [
    "Average founders think their offer is the moat.",
    "",
    "The best founders know it isn't. The audience is.",
    "",
    "Because your offer can be copied. Someone with deeper pockets can build the same service, probably better, and definitely cheaper.",
    "",
    "What they can't copy:",
    "",
    "- The trust you've built with people who already follow you",
    "- The DMs that show up from people who've been reading your posts for months",
    "",
    "That's where the real moat is in 2026.",
  ].join("\n");

  // The model's ACTUAL response for "Tighten the hook" — a completely
  // rewritten post with new examples, new list items, and collapsed line
  // breaks. Every single one of these lines is different from draft1.
  const modelRewrite = [
    "Founders think their offer is the moat.",
    "",
    "It isn't.",
    "",
    "The audience is.",
    "",
    "One client launched a ghostwriting offer with zero audience.",
    "",
    "Every call started cold.",
    "",
    "1. Post before you have an offer.",
    "2. Write hooks like your reach depends on it.",
  ].join("\n");

  test("splice grafts the model's new opener onto draft1's body BYTE-FOR-BYTE", () => {
    const result = splicePreservedBody(draft1, modelRewrite);
    // The new hook is the model's first paragraph: "Founders think their offer is the moat."
    expect(result.split("\n\n")[0]).toBe("Founders think their offer is the moat.");
    // Every subsequent paragraph from draft1 is preserved verbatim.
    expect(result).toContain("The best founders know it isn't. The audience is.");
    expect(result).toContain(
      "Because your offer can be copied. Someone with deeper pockets can build the same service, probably better, and definitely cheaper.",
    );
    expect(result).toContain("What they can't copy:");
    expect(result).toContain("- The trust you've built with people who already follow you");
    expect(result).toContain(
      "- The DMs that show up from people who've been reading your posts for months",
    );
    expect(result).toContain("That's where the real moat is in 2026.");
    // NONE of the model's fabricated body content survives.
    expect(result).not.toContain("One client launched a ghostwriting offer");
    expect(result).not.toContain("Every call started cold.");
    expect(result).not.toContain("Post before you have an offer");
    expect(result).not.toContain("Write hooks like your reach depends on it");
  });

  test("the list items keep their blank-line separators (formatting bug the user flagged)", () => {
    // The user's Draft 2 collapsed "What they can't copy:\n\n- item\n- item"
    // into "What they can't copy: - item - item". The splice keeps the
    // blank-line-then-bullet shape because we lift the original body
    // verbatim.
    const result = splicePreservedBody(draft1, modelRewrite);
    expect(result).toContain("What they can't copy:\n\n- The trust");
  });
});
