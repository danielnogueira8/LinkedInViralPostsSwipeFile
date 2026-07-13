import { describe, test, expect } from "vitest";
import {
  filterChats,
  chatGroupFor,
  groupChatsByDate,
  CHAT_GROUP_LABEL,
} from "@/lib/chat-ui-policy";

// ---------------------------------------------------------------------------
// Chat-history organization: the pure search-filter + date-grouping helpers
// behind the redesigned chat list (search box + Today / Yesterday / Previous 7
// days / Older sections). Hermetic; `now` is injected so grouping is
// deterministic.
// ---------------------------------------------------------------------------

// Anchor NOW at local noon so day math is unambiguous regardless of the test
// runner's timezone (grouping is intentionally by the user's LOCAL calendar
// day). Build relative timestamps with a local-time helper rather than UTC
// literals, so "yesterday" is always the local previous day.
const NOW = new Date(2026, 5, 27, 12, 0, 0); // 2026-06-27 12:00 local

// `daysAgo` whole days back from NOW (local), `hour` sets the local hour.
function at(daysAgo: number, hour: number): string {
  return new Date(2026, 5, 27 - daysAgo, hour, 0, 0).toISOString();
}

function chat(id: string, title: string, updated_at: string) {
  return { id, title, updated_at };
}

describe("filterChats — search by title", () => {
  const chats = [
    chat("a", "Cold outreach hooks", at(0, 10)),
    chat("b", "GTM strategy post", at(0, 9)),
    chat("c", "Lead magnet breakdown", at(1, 9)),
  ];

  test("empty query returns everything (untouched order)", () => {
    expect(filterChats(chats, "").map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(filterChats(chats, "   ").map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  test("matches title case-insensitively, anywhere in the string", () => {
    expect(filterChats(chats, "hook").map((c) => c.id)).toEqual(["a"]);
    expect(filterChats(chats, "POST").map((c) => c.id)).toEqual(["b"]);
    expect(filterChats(chats, "magnet").map((c) => c.id)).toEqual(["c"]);
  });

  test("no match returns empty", () => {
    expect(filterChats(chats, "zzz")).toEqual([]);
  });
});

describe("chatGroupFor — calendar-day buckets (local)", () => {
  test("same calendar day is 'today' (even early morning)", () => {
    expect(chatGroupFor(at(0, 1), NOW)).toBe("today");
  });
  test("previous calendar day is 'yesterday'", () => {
    expect(chatGroupFor(at(1, 23), NOW)).toBe("yesterday");
  });
  test("2-7 days ago is 'previous7'", () => {
    expect(chatGroupFor(at(3, 12), NOW)).toBe("previous7");
    expect(chatGroupFor(at(7, 12), NOW)).toBe("previous7");
  });
  test("more than 7 days ago is 'older'", () => {
    expect(chatGroupFor(at(8, 12), NOW)).toBe("older");
    expect(chatGroupFor(at(180, 12), NOW)).toBe("older");
  });
  test("a same-day future-ish timestamp (clock skew) buckets as 'today', never crashes", () => {
    expect(chatGroupFor(at(0, 23), NOW)).toBe("today");
  });
});

describe("groupChatsByDate — ordered, non-empty sections", () => {
  test("buckets chats and preserves input order within each section", () => {
    const chats = [
      chat("t1", "today one", at(0, 11)),
      chat("t2", "today two", at(0, 8)),
      chat("y1", "yesterday", at(1, 20)),
      chat("p1", "this week", at(4, 20)),
      chat("o1", "old", at(57, 20)),
    ];
    const groups = groupChatsByDate(chats, NOW);
    expect(groups.map((g) => g.key)).toEqual([
      "today",
      "yesterday",
      "previous7",
      "older",
    ]);
    expect(groups[0].chats.map((c) => c.id)).toEqual(["t1", "t2"]);
    expect(groups[1].chats.map((c) => c.id)).toEqual(["y1"]);
  });

  test("omits empty sections (only today → one group)", () => {
    const groups = groupChatsByDate([chat("a", "x", at(0, 10))], NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("today");
  });

  test("every group key has a human label", () => {
    for (const key of ["today", "yesterday", "previous7", "older"] as const) {
      expect(CHAT_GROUP_LABEL[key]).toBeTruthy();
    }
  });
});
