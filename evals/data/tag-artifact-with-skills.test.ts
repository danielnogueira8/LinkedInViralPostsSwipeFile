import { describe, test, expect } from "vitest";
import { tagArtifactWithSkills } from "@/lib/agent/chat-turn";
import type { Artifact } from "@/lib/agent/contracts";

// ---------------------------------------------------------------------------
// Artifact tagging: when a turn ran with active custom skills, every generated
// draft (post/hook) gets the slug list on meta.skills so the card can render a
// /name chip next to the "Draft" badge. cite artifacts are passthrough source
// references (not generated content), so they stay untagged.
// ---------------------------------------------------------------------------

const post = (overrides: Partial<Artifact> = {}): Artifact => ({
  id: "a1",
  kind: "post",
  title: "Untitled",
  body: "...",
  ...overrides,
});

describe("tagArtifactWithSkills — stamps active skill slugs on generated drafts", () => {
  test("no active skills → passthrough (identical reference, no work)", () => {
    const a = post();
    expect(tagArtifactWithSkills(a, [])).toBe(a);
  });

  test("a post under one active skill gets meta.skills = [slug]", () => {
    const out = tagArtifactWithSkills(post(), ["cta"]);
    expect((out.meta as { skills?: unknown })?.skills).toEqual(["cta"]);
  });

  test("a hook is tagged the same way as a post", () => {
    const out = tagArtifactWithSkills(post({ kind: "hook" }), ["cta"]);
    expect(out.kind).toBe("hook");
    expect((out.meta as { skills?: unknown })?.skills).toEqual(["cta"]);
  });

  test("cite artifacts are NEVER tagged (they're passthrough references)", () => {
    const a = post({ kind: "cite" });
    const out = tagArtifactWithSkills(a, ["cta"]);
    expect(out).toBe(a); // unchanged reference
    expect((out.meta as { skills?: unknown })?.skills).toBeUndefined();
  });

  test("existing meta keys are preserved (skills is merged, not replacing)", () => {
    const a = post({ meta: { postId: "p_123", versions: ["v1"] } });
    const out = tagArtifactWithSkills(a, ["cta"]);
    expect(out.meta).toEqual({
      postId: "p_123",
      versions: ["v1"],
      skills: ["cta"],
    });
  });

  test("multiple slugs are passed through in order", () => {
    const out = tagArtifactWithSkills(post(), ["cta", "newsletter-mention"]);
    expect((out.meta as { skills?: string[] })?.skills).toEqual([
      "cta",
      "newsletter-mention",
    ]);
  });

  test("the source artifact is never mutated (functional)", () => {
    const a = post({ meta: { postId: "p_1" } });
    const snap = JSON.stringify(a);
    tagArtifactWithSkills(a, ["cta"]);
    expect(JSON.stringify(a)).toBe(snap);
  });
});
