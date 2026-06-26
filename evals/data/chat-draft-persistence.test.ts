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
