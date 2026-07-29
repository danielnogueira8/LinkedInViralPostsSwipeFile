import { describe, test, expect } from "vitest";
import {
  latestPersistedModelSource,
  summarizeChatContext,
  isContextSummaryEmpty,
  type ContextSourcePost,
} from "@/lib/cowork-context-summary";
import { hydrate } from "@/lib/chat-hydration";

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

  test("restores the owning chat's modeled source from its persisted transcript", () => {
    const messages = hydrate([
      {
        id: "user-a",
        role: "user",
        content: "Model this in my voice.",
        artifacts: null,
        model_source_id: "source-a",
        model_source_attachment: {
          id: "source-a",
          kind: "swipe",
          state: "available",
          authorName: "Ada",
          authorAvatar: null,
          postText: "A source post that must survive switching chats.",
          partial: false,
          postType: "regular",
        },
      },
    ]);

    const summary = summarizeChatContext({ messages });

    expect(summary.sourcePost).toMatchObject({
      kind: "swipe",
      authorName: "Ada",
      postText: "A source post that must survive switching chats.",
    });
    expect(isContextSummaryEmpty(summary)).toBe(false);
  });

  test("keeps restored modeled sources scoped to their owning chat transcript", () => {
    const messageFor = (chat: "A" | "B") =>
      hydrate([
        {
          id: `user-${chat}`,
          role: "user" as const,
          content: `Model source ${chat}.`,
          artifacts: null,
          model_source_id: `source-${chat}`,
          model_source_attachment: {
            id: `source-${chat}`,
            kind: "swipe" as const,
            state: "available" as const,
            authorName: `Author ${chat}`,
            authorAvatar: null,
            postText: `Post ${chat}`,
            partial: false,
            postType: "regular" as const,
          },
        },
      ]);

    expect(latestPersistedModelSource(messageFor("A"))?.id).toBe("source-A");
    expect(latestPersistedModelSource(messageFor("B"))?.id).toBe("source-B");
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
