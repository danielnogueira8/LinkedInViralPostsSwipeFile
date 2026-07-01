import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { draftKey, readDraft, writeDraft } from "@/app/(app)/dashboard/chat-workspace";

// ---------------------------------------------------------------------------
// Unit tests for the per-chat unsent-draft persistence helpers. These back the
// "typed a message, switched chats, came back — text is still there" behavior.
// Pure-ish (localStorage only), so we stub a minimal localStorage and assert the
// round-trip + the key scheme + the must-never-throw safety. Runs in the default
// hermetic suite.
// ---------------------------------------------------------------------------

function makeFakeLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    _store: store,
  };
}

const realLS = (globalThis as { localStorage?: unknown }).localStorage;

afterEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = realLS;
});

describe("draftKey", () => {
  test("scopes by chat id, with a sentinel for the not-yet-created chat", () => {
    expect(draftKey("chat-123")).toBe("swipein:chat-draft:chat-123");
    expect(draftKey(null)).toBe("swipein:chat-draft:__new__");
  });
});

describe("readDraft / writeDraft round-trip", () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = makeFakeLocalStorage();
  });

  test("writes then reads back the same text, scoped per chat", () => {
    writeDraft("a", "draft for A");
    writeDraft("b", "draft for B");
    expect(readDraft("a")).toBe("draft for A");
    expect(readDraft("b")).toBe("draft for B");
    expect(readDraft("c")).toBe(""); // never written → empty
  });

  test("the new-chat sentinel is its own slot", () => {
    writeDraft(null, "unsent for the new chat");
    expect(readDraft(null)).toBe("unsent for the new chat");
    expect(readDraft("some-chat")).toBe("");
  });

  test("writing empty/whitespace clears the slot (so a sent message leaves nothing)", () => {
    writeDraft("a", "something");
    expect(readDraft("a")).toBe("something");
    writeDraft("a", ""); // e.g. after send clears the composer
    expect(readDraft("a")).toBe("");
    writeDraft("a", "   "); // whitespace-only also clears
    expect(readDraft("a")).toBe("");
  });
});

describe("safety: localStorage throwing never breaks the composer", () => {
  test("readDraft returns '' when localStorage.getItem throws (private mode)", () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error("SecurityError: localStorage disabled");
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(() => readDraft("a")).not.toThrow();
    expect(readDraft("a")).toBe("");
  });

  test("writeDraft swallows a throwing setItem (quota / disabled)", () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("disabled");
      },
    };
    expect(() => writeDraft("a", "x")).not.toThrow();
    expect(() => writeDraft("a", "")).not.toThrow();
  });

  test("absent localStorage (SSR-like) doesn't throw", () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(() => readDraft("a")).not.toThrow();
    expect(readDraft("a")).toBe("");
    expect(() => writeDraft("a", "x")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Draft "Model in Chat" handoff invariant. The bug: clicking Model in Chat on a
// Posts-page draft opened the chat but lost the post context. Root cause — the
// ?draft= effect created a fresh chat, switched to it (setActiveId), then
// prefilled the refine message (setInput). But the composer's per-chat draft
// swap runs DURING RENDER when activeId changes: it calls
// setInput(readDraft(newChatId)), which is empty for a brand-new chat, clobbering
// the prefill. The fix seeds the store with the message BEFORE switching, so the
// swap reads it back. This test locks that ordering invariant at the helper level.
// ---------------------------------------------------------------------------
describe("Model-in-Chat draft handoff seeds the new chat's draft before the swap", () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = makeFakeLocalStorage();
  });

  test("seeding writeDraft(newChatId, message) survives the activeId swap read", () => {
    const newChatId = "chat-from-model-in-chat";
    const message =
      'Refine this post: [tell me what to change]\n\n' +
      "Keep it in my voice. Here's the current post:\n" +
      '"""\nMy saved draft body.\n"""';

    // Effect seeds the store BEFORE setActiveId(newChatId).
    writeDraft(newChatId, message);

    // The render-phase swap then runs setInput(readDraft(newChatId)). With the
    // seed in place it reads back the refine message — NOT "" — so the post
    // context survives the chat switch.
    expect(readDraft(newChatId)).toBe(message);
  });

  test("WITHOUT the seed, a fresh chat reads empty — the original bug", () => {
    // No writeDraft before the switch: readDraft on a brand-new chat is "",
    // which is exactly what clobbered the prefill before the fix.
    expect(readDraft("brand-new-chat-no-seed")).toBe("");
  });

  // Regression: the swipe-file / bookmark "Model this post" action (intent=model)
  // goes through the SAME ?model= effect. When the old ?draft= effect was folded
  // into ?model=, the seed write was dropped for this path, so clicking "Model
  // this post" showed a BLANK composer (no "in my voice" prompt). This pins that
  // the model intent's real prompt survives the swap once seeded.
  test("the 'Model this post' (intent=model) prompt survives the swap when seeded", async () => {
    const { POST_INTENTS } = await import("@/lib/post-intents");
    const prompt = POST_INTENTS.model.prompt;
    // Sanity: it's the voice-aware predefined prompt the user expects to see.
    expect(prompt).toMatch(/in my voice/i);

    const newChatId = "chat-from-model-this-post";
    writeDraft(newChatId, prompt); // effect seeds BEFORE setActiveId
    expect(readDraft(newChatId)).toBe(prompt); // swap reads it back, not ""
  });
});
