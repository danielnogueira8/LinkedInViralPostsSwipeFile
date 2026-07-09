import { describe, expect, test } from "vitest";
import { maxReactionsByAccount } from "@/lib/source-output";

describe("maxReactionsByAccount", () => {
  test("reduces narrow rows to the max reaction per account", () => {
    const map = maxReactionsByAccount([
      { account_id: "a", reactions: 10 },
      { account_id: "a", reactions: 843 },
      { account_id: "a", reactions: 5 },
      { account_id: "b", reactions: 20 },
    ]);
    expect(map.get("a")).toBe(843);
    expect(map.get("b")).toBe(20);
  });

  test("treats null reactions as 0 and omits accounts with no posts", () => {
    const map = maxReactionsByAccount([{ account_id: "a", reactions: null }]);
    expect(map.get("a")).toBe(0);
    expect(map.has("missing")).toBe(false);
  });

  test("null/undefined input → empty map", () => {
    expect(maxReactionsByAccount(null).size).toBe(0);
    expect(maxReactionsByAccount(undefined).size).toBe(0);
  });
});
