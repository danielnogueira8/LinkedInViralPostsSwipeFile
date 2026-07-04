import { describe, test, expect } from "vitest";
import {
  applyRefineSwap,
  draftVersions,
  isHookFocusedRefine,
  looksLikeComposerRefine,
  askAnswerShouldRefineLatestDraft,
  artifactSkillNames,
  skillNamesToIds,
  splitHook,
  splicePreservedBody,
  guardRefineCollapse,
  reinsertArtifact,
  type Artifact,
} from "@/app/(app)/dashboard/chat-workspace";

// ---------------------------------------------------------------------------
// "Edit a draft with AI updates the current draft, not a new one." applyRefineSwap
// replaces the refined card in place and keeps a version history; draftVersions
// reads that history back. Pure logic, fully unit-tested.
// ---------------------------------------------------------------------------

const mk = (id: string, body: string, meta?: Record<string, unknown>): Artifact => ({
  id,
  kind: "post",
  title: body.split("\n", 1)[0],
  body,
  ...(meta ? { meta } : {}),
});

describe("applyRefineSwap — refine updates the target card in place", () => {
  test("replaces the target's body and does NOT add a new card", () => {
    const list = [mk("a1", "Original post body."), mk("a2", "Another draft.")];
    const incoming = mk("a_new", "Refined, punchier body.");
    const out = applyRefineSwap(list, "a1", incoming);

    expect(out).toHaveLength(2); // still 2 cards — no new one
    expect(out.map((a) => a.id)).toEqual(["a1", "a2"]); // same ids, in order
    const target = out.find((a) => a.id === "a1")!;
    expect(target.body).toBe("Refined, punchier body.");
    // The incoming artifact's id is gone — it superseded the target.
    expect(out.some((a) => a.id === "a_new")).toBe(false);
  });

  test("seeds version history with [original, refined] on the first refine", () => {
    const out = applyRefineSwap([mk("a1", "v1 body")], "a1", mk("a_new", "v2 body"));
    const v = draftVersions(out[0]);
    expect(v).toEqual({ versions: ["v1 body", "v2 body"], versionIndex: 1 });
  });

  test("appends to existing history on a second refine (keeps all versions)", () => {
    const afterFirst = applyRefineSwap([mk("a1", "v1")], "a1", mk("n1", "v2"));
    const afterSecond = applyRefineSwap(afterFirst, "a1", mk("n2", "v3"));
    const v = draftVersions(afterSecond[0]);
    expect(v).toEqual({ versions: ["v1", "v2", "v3"], versionIndex: 2 });
    expect(afterSecond[0].body).toBe("v3"); // newest is active
  });

  test("keeps the target's title when the refine has no usable first line", () => {
    const list = [mk("a1", "Keep this title")];
    const incoming: Artifact = { id: "n", kind: "post", title: "", body: "new body" };
    const out = applyRefineSwap(list, "a1", incoming);
    expect(out[0].title).toBe("Keep this title");
  });

  test("FALLBACK: if the target is gone (deleted mid-turn), append the incoming", () => {
    const list = [mk("other", "unrelated")];
    const incoming = mk("n", "the refine result");
    const out = applyRefineSwap(list, "missing-id", incoming);
    expect(out).toHaveLength(2);
    expect(out.some((a) => a.id === "n")).toBe(true); // not silently dropped
  });

  test("FALLBACK: a no-op refine (identical body) appends rather than corrupting history", () => {
    const list = [mk("a1", "same body")];
    const out = applyRefineSwap(list, "a1", mk("n", "same body"));
    // Identical body → treated as a separate card, no bogus 1-version history.
    expect(out).toHaveLength(2);
    expect(draftVersions(out.find((a) => a.id === "a1")!)).toBeNull();
  });

  test("does not mutate the input array or its artifacts", () => {
    const list = [mk("a1", "orig")];
    const snapshot = JSON.parse(JSON.stringify(list));
    applyRefineSwap(list, "a1", mk("n", "refined"));
    expect(list).toEqual(snapshot);
  });

  test("preserves the target's /skill badge across a refine", () => {
    // The target was produced under /cta; the incoming refine (which inherited
    // /cta) is also tagged. The swapped card must keep skills:['cta'].
    const list = [mk("a1", "orig", { skills: ["cta"] })];
    const incoming = mk("n", "refined", { skills: ["cta"] });
    const out = applyRefineSwap(list, "a1", incoming);
    expect((out[0].meta as { skills?: string[] }).skills).toEqual(["cta"]);
  });

  test("a NEW skill applied on the refine wins over the target's old skills", () => {
    const list = [mk("a1", "orig", { skills: ["cta"] })];
    const incoming = mk("n", "refined", { skills: ["storytelling"] });
    const out = applyRefineSwap(list, "a1", incoming);
    expect((out[0].meta as { skills?: string[] }).skills).toEqual(["storytelling"]);
  });

  test("target had a skill, refine has none → keeps the target's skill", () => {
    // e.g. an inherited refine where the server tag didn't round-trip; fall
    // back to the target's existing skills so the badge doesn't drop.
    const list = [mk("a1", "orig", { skills: ["cta"] })];
    const incoming = mk("n", "refined"); // no skills on incoming
    const out = applyRefineSwap(list, "a1", incoming);
    expect((out[0].meta as { skills?: string[] }).skills).toEqual(["cta"]);
  });

  test("no skills anywhere → meta has no skills key", () => {
    const out = applyRefineSwap([mk("a1", "orig")], "a1", mk("n", "refined"));
    expect((out[0].meta as { skills?: string[] }).skills).toBeUndefined();
  });
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

describe("draftVersions — reads version history off meta", () => {
  test("null when there's no history (a fresh, never-refined draft)", () => {
    expect(draftVersions(mk("a1", "body"))).toBeNull();
  });

  test("null when there's only a single version (no real history)", () => {
    expect(draftVersions(mk("a1", "body", { versions: ["body"], versionIndex: 0 }))).toBeNull();
  });

  test("returns the versions + active index when present", () => {
    const a = mk("a1", "v2", { versions: ["v1", "v2"], versionIndex: 1 });
    expect(draftVersions(a)).toEqual({ versions: ["v1", "v2"], versionIndex: 1 });
  });

  test("null when meta is malformed (versionIndex missing)", () => {
    expect(draftVersions(mk("a1", "b", { versions: ["v1", "v2"] }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Server-side jsonb rewrite (PATCH /artifacts): the durable half. Replaces the
// target in place and drops the superseding artifact so a reload shows ONE
// evolved card. Pure helper, tested without the Clerk/Supabase route shell.
// ---------------------------------------------------------------------------

import { rewriteArtifactsForRefine } from "@/app/api/chats/[id]/artifacts/route";

describe("rewriteArtifactsForRefine — durable in-place swap", () => {
  test("replaces the target body+meta and drops the superseding artifact", () => {
    const arts = [
      { id: "t", kind: "post", title: "T", body: "old" },
      { id: "s", kind: "post", title: "S", body: "the refine result" },
    ];
    const res = rewriteArtifactsForRefine(arts, {
      targetId: "t",
      body: "new body",
      title: "New T",
      meta: { versions: ["old", "new body"], versionIndex: 1 },
      supersedeId: "s",
    });
    expect(res.changed).toBe(true);
    expect(res.updated).toBe(true);
    expect(res.superseded).toBe(true);
    // One card left: the target, evolved.
    expect(res.next).toHaveLength(1);
    expect(res.next[0]).toMatchObject({
      id: "t",
      body: "new body",
      title: "New T",
      meta: { versionIndex: 1 },
    });
  });

  test("target + supersede in SEPARATE messages: each call touches only what it holds", () => {
    // The target lives in an older assistant message; the supersede in the new
    // one. Each message is rewritten independently by its own call.
    const olderMsg = [{ id: "t", kind: "post", title: "T", body: "old" }];
    const newerMsg = [{ id: "s", kind: "post", title: "S", body: "refined" }];
    const a = rewriteArtifactsForRefine(olderMsg, { targetId: "t", body: "new", supersedeId: "s", targetExists: true });
    const b = rewriteArtifactsForRefine(newerMsg, { targetId: "t", body: "new", supersedeId: "s", targetExists: true });
    expect(a.updated).toBe(true);
    expect(a.superseded).toBe(false); // supersede isn't in this message
    expect(a.next[0].body).toBe("new");
    expect(b.superseded).toBe(true); // dropped here
    expect(b.next).toHaveLength(0);
    expect(b.updated).toBe(false);
  });

  test("target missing globally + supersede present converts supersede into the evolved target", () => {
    const newerMsg = [{ id: "s", kind: "post", title: "S", body: "refined" }];
    const res = rewriteArtifactsForRefine(newerMsg, {
      targetId: "t",
      body: "new",
      title: "New T",
      meta: { versions: ["old", "new"], versionIndex: 1 },
      supersedeId: "s",
      targetExists: false,
    });
    expect(res.changed).toBe(true);
    expect(res.updated).toBe(true);
    expect(res.superseded).toBe(true);
    expect(res.next).toHaveLength(1);
    expect(res.next[0]).toMatchObject({
      id: "t",
      title: "New T",
      body: "new",
      meta: { versionIndex: 1 },
    });
  });

  test("changed=false when neither target nor supersede is present (no write)", () => {
    const arts = [{ id: "x", kind: "post", title: "X", body: "z" }];
    const res = rewriteArtifactsForRefine(arts, { targetId: "t", body: "new", supersedeId: "s" });
    expect(res.changed).toBe(false);
    expect(res.next).toEqual(arts);
  });

  test("no supersedeId → only the in-place body update (version-step persist)", () => {
    const arts = [{ id: "t", kind: "post", title: "T", body: "v2", meta: { versions: ["v1", "v2"], versionIndex: 1 } }];
    const res = rewriteArtifactsForRefine(arts, {
      targetId: "t",
      body: "v1",
      meta: { versions: ["v1", "v2"], versionIndex: 0 },
    });
    expect(res.superseded).toBe(false);
    expect(res.next[0].body).toBe("v1");
    expect((res.next[0].meta as { versionIndex: number }).versionIndex).toBe(0);
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
    "stronger CTA",
    "rewrite the first line",
    "punchier opening",
    "change the call to action",
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

describe("splicePreservedBody — keep the new hook, preserve the original body", () => {
  const original =
    "Most cold outreach is dead.\n\nHere's what replaced it.\n\nStop guessing — start testing.";

  test("grafts the refined hook onto the ORIGINAL body verbatim", () => {
    // GLM rewrote the whole post (new hook AND a mangled, unformatted body).
    const refined =
      "Cold outreach is a graveyard. Nobody replies anymore and here is the thing everyone keeps doing wrong they keep sending the same templates.";
    const out = splicePreservedBody(original, refined);
    // New hook kept, original body restored exactly (formatting included).
    expect(out).toBe(
      "Cold outreach is a graveyard. Nobody replies anymore and here is the thing everyone keeps doing wrong they keep sending the same templates.\n\nHere's what replaced it.\n\nStop guessing — start testing.",
    );
    // The original body paragraphs survive byte-for-byte.
    expect(out).toContain("Here's what replaced it.\n\nStop guessing — start testing.");
  });

  test("preserves the body even when the refine kept its own (different) body", () => {
    const refined = "A brand new hook.\n\nAnd a totally different body the user didn't want.";
    const out = splicePreservedBody(original, refined);
    expect(out).toBe(
      "A brand new hook.\n\nHere's what replaced it.\n\nStop guessing — start testing.",
    );
  });

  test("no-op when the refined hook equals the original (model only touched the body)", () => {
    const refined = "Most cold outreach is dead.\n\nSome rewritten body.";
    // Splicing would just restore the original body and discard the model's
    // (unwanted) body change — but since the hook is unchanged, return refined.
    expect(splicePreservedBody(original, refined)).toBe(refined);
  });

  test("returns refined unchanged when the ORIGINAL has no body to preserve", () => {
    // Original is a single paragraph → nothing to graft → refined stands.
    expect(splicePreservedBody("One para only.", "A new one para.")).toBe("A new one para.");
  });

  test("a flat single-block refine still gets the original body grafted back on", () => {
    // The wall-of-text case this guard exists for: GLM returns the whole refined
    // post as one block. Treat it as the new opener and restore the real body.
    const out = splicePreservedBody(original, "A punchier one-line opener.");
    expect(out).toBe(
      "A punchier one-line opener.\n\nHere's what replaced it.\n\nStop guessing — start testing.",
    );
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
