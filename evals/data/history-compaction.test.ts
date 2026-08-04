import { describe, expect, test } from "vitest";
import {
  compactedHistoryBlock,
  droppedHistory,
  extractDurableFacts,
  MAX_COMPACTED_CHARS,
} from "@/lib/agent/history-compaction";
import { windowChatHistory, MAX_HISTORY_USER_TURNS } from "@/lib/agent/history";
import type { ChatMessage } from "@/lib/openrouter";

const user = (content: string): ChatMessage => ({ role: "user", content });
const assistant = (content: string): ChatMessage => ({
  role: "assistant",
  content,
});

/** A chat of `turns` user messages, each answered. */
function conversation(turns: number, first?: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 1; i <= turns; i += 1) {
    out.push(user(i === 1 && first ? first : `Make the hook punchier, take ${i}.`));
    out.push(assistant(`Done, revision ${i}.`));
  }
  return out;
}

describe("the drop boundary matches the window's", () => {
  test("nothing is dropped while inside the window", () => {
    expect(droppedHistory(conversation(MAX_HISTORY_USER_TURNS))).toEqual([]);
  });

  test("dropped + windowed together account for the whole transcript", () => {
    // If these two disagree, a turn is either double-counted or lost in the
    // gap — the failure mode that would make compaction silently incomplete.
    const history = conversation(MAX_HISTORY_USER_TURNS + 6);
    const dropped = droppedHistory(history);
    const kept = windowChatHistory(history);
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped.length + kept.length).toBe(history.length);
  });
});

describe("what survives the window", () => {
  const FACT =
    "We charge $12k per engagement and our best client came from a LinkedIn post about pricing.";

  test("a fact from turn 1 is still available at turn 26", () => {
    // The whole point. Before compaction this was unreachable: the agent could
    // not tell "you never said that" from "I can no longer see it".
    const history = conversation(MAX_HISTORY_USER_TURNS + 6, FACT);
    const block = compactedHistoryBlock(history);
    expect(block).toContain("$12k");
    expect(windowChatHistory(history).map((m) => m.content).join(" ")).not.toContain(
      "$12k",
    );
  });

  test("the block names how many turns it stands in for", () => {
    const block = compactedHistoryBlock(
      conversation(MAX_HISTORY_USER_TURNS + 6, FACT),
    );
    expect(block).toContain("EARLIER IN THIS CONVERSATION");
    expect(block).toMatch(/\d+ turns/);
  });

  test("it instructs the model not to deny the facts", () => {
    // Without this the model can read a terse note as low-confidence and tell
    // the user they never mentioned it — worse than staying silent.
    const block = compactedHistoryBlock(
      conversation(MAX_HISTORY_USER_TURNS + 6, FACT),
    );
    expect(block).toContain("never claim they were not mentioned");
  });
});

describe("what is deliberately NOT carried", () => {
  test("nothing is emitted while the whole chat still fits", () => {
    expect(compactedHistoryBlock(conversation(5, "We charge $12k per client."))).toBe(
      "",
    );
  });

  test("executed instructions are not remembered as facts", () => {
    // "make it shorter" was already carried out; as memory it is noise that
    // crowds out the durable facts.
    expect(
      extractDurableFacts([
        user("make it shorter"),
        user("post 2"),
        user("ok"),
        user("Actually yes do that"),
      ]),
    ).toEqual([]);
  });

  test("assistant output never becomes remembered fact", () => {
    // Folding the agent's own words back in as memory lets an early guess
    // harden into permanent "truth".
    expect(
      extractDurableFacts([
        assistant("I think we charge $12k per client and have 40 customers."),
      ]),
    ).toEqual([]);
  });

  test("a chat with only chatter yields no block", () => {
    const history: ChatMessage[] = [];
    for (let i = 0; i < MAX_HISTORY_USER_TURNS + 8; i += 1) {
      history.push(user("ok"), assistant("Done."));
    }
    expect(compactedHistoryBlock(history)).toBe("");
  });
});

describe("the block stays bounded", () => {
  test("a very long chat cannot grow the prompt without limit", () => {
    // Compaction must not reintroduce the unbounded-context problem the
    // window exists to prevent.
    const history: ChatMessage[] = [];
    for (let i = 0; i < 120; i += 1) {
      history.push(
        user(
          `In ${2020 + (i % 6)} our agency signed ${i + 3} clients and we charge $${i + 5}k per retainer for our team.`,
        ),
        assistant("Noted."),
      );
    }
    const block = compactedHistoryBlock(history);
    expect(block.length).toBeGreaterThan(0);
    expect(block.length).toBeLessThanOrEqual(MAX_COMPACTED_CHARS);
  });

  test("facts are dropped whole, never cut mid-sentence", () => {
    const history: ChatMessage[] = [];
    for (let i = 0; i < 120; i += 1) {
      history.push(
        user(`We built ${i + 2} funnels for our client Acme in 202${i % 5}.`),
        assistant("Noted."),
      );
    }
    for (const line of compactedHistoryBlock(history).split("\n")) {
      if (!line.startsWith("- ")) continue;
      expect(line.endsWith("…")).toBe(false);
    }
  });
});
