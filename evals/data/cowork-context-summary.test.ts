import { describe, test, expect } from "vitest";
import {
  summarizeChatContext,
  isContextSummaryEmpty,
  type ContextSourcePost,
} from "@/lib/cowork-context-summary";

// ---------------------------------------------------------------------------
// summarizeChatContext folds the per-message context the transcript already
// carries into one referenceable summary for the Cowork context card.
// ---------------------------------------------------------------------------

const source: ContextSourcePost = {
  authorName: "Damon Millar",
  authorAvatar: null,
  postText: "Comment PLAYBOOK and I'll send it.",
  partial: false,
  postType: "lead_magnet",
  kind: "swipe",
};

describe("summarizeChatContext", () => {
  test("empty chat → empty summary", () => {
    const s = summarizeChatContext({ messages: [] });
    expect(isContextSummaryEmpty(s)).toBe(true);
    expect(s.sourcePost).toBeNull();
    expect(s.skills).toEqual([]);
  });

  test("unions skills, formats, and files across messages, de-duped, first-seen order", () => {
    const s = summarizeChatContext({
      messages: [
        { skills: ["damon-millar-linkedin"], files: ["a.pdf"], postFormat: "Listicle" },
        { skills: ["lead-magnet-resource-builder", "damon-millar-linkedin"], files: ["a.pdf", "b.png"] },
        { postFormat: "Story" },
      ],
    });
    expect(s.skills).toEqual(["damon-millar-linkedin", "lead-magnet-resource-builder"]);
    expect(s.files).toEqual(["a.pdf", "b.png"]);
    expect(s.postFormats).toEqual(["Listicle", "Story"]);
    expect(isContextSummaryEmpty(s)).toBe(false);
  });

  test("single-valued context (creator style, lead magnet) takes the LAST non-empty value", () => {
    const s = summarizeChatContext({
      messages: [
        { creatorStyle: { name: "s1", creatorName: "First" }, leadMagnet: { title: "Old pack", selection: "auto" } },
        {},
        { creatorStyle: { name: "s2", creatorName: "Second" }, leadMagnet: { title: "New pack", selection: "manual" } },
      ],
    });
    expect(s.creatorStyle).toEqual({ name: "s2", creatorName: "Second" });
    expect(s.leadMagnet?.title).toBe("New pack");
    expect(s.leadMagnet?.selection).toBe("manual");
  });

  test("a later empty turn does NOT clear an earlier creator style / lead magnet", () => {
    const s = summarizeChatContext({
      messages: [
        { creatorStyle: { name: "s1", creatorName: "First" }, leadMagnet: { title: "Pack", selection: "manual" } },
        {}, // a plain follow-up turn with no context attached
      ],
    });
    expect(s.creatorStyle?.creatorName).toBe("First");
    expect(s.leadMagnet?.title).toBe("Pack");
  });

  test("carries the source post through and reports non-empty even with no message context", () => {
    const s = summarizeChatContext({ messages: [], sourcePost: source });
    expect(s.sourcePost).toEqual(source);
    expect(isContextSummaryEmpty(s)).toBe(false);
  });

  test("blank / whitespace skill and file names are ignored", () => {
    const s = summarizeChatContext({
      messages: [{ skills: ["  ", ""], files: ["   "], postFormat: "  " }],
    });
    expect(s.skills).toEqual([]);
    expect(s.files).toEqual([]);
    expect(s.postFormats).toEqual([]);
    expect(isContextSummaryEmpty(s)).toBe(true);
  });
});
