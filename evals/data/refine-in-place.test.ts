import { describe, test, expect } from "vitest";
import {
  applyRefineSwap,
  draftVersions,
  isHookFocusedRefine,
  splitHook,
  splicePreservedBody,
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
    const a = rewriteArtifactsForRefine(olderMsg, { targetId: "t", body: "new", supersedeId: "s" });
    const b = rewriteArtifactsForRefine(newerMsg, { targetId: "t", body: "new", supersedeId: "s" });
    expect(a.updated).toBe(true);
    expect(a.superseded).toBe(false); // supersede isn't in this message
    expect(a.next[0].body).toBe("new");
    expect(b.superseded).toBe(true); // dropped here
    expect(b.next).toHaveLength(0);
    expect(b.updated).toBe(false);
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
