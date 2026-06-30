import { describe, test, expect } from "vitest";
import { hydrate, type RawDbMessage } from "@/app/(app)/dashboard/chat-workspace";

// ---------------------------------------------------------------------------
// AskCard rehydration after a hard refresh (bug 1 — "checkboxes gone after
// refresh"). The flow: agent ends a turn on ask_user → server persists the
// tool_call → hydrate reconstructs the AskQuestion from those tool_calls on
// reload. Without this, the user saw only the prose, never the interactive
// card with checkboxes.
// ---------------------------------------------------------------------------

const askToolCall = (args: Record<string, unknown>) => ({
  id: "tc_test",
  type: "function" as const,
  function: { name: "ask_user", arguments: JSON.stringify(args) },
});

describe("hydrate — reconstructs an AskCard from a persisted ask_user tool_call", () => {
  test("a normal assistant message → no ask attached", () => {
    const rows: RawDbMessage[] = [
      { id: "1", role: "user", content: "hi", artifacts: null },
      { id: "2", role: "assistant", content: "hello", artifacts: null },
    ];
    const out = hydrate(rows);
    expect(out[1].ask).toBeUndefined();
  });

  test("assistant with a persisted ask_user tool_call → ask reconstructed with options", () => {
    const rows: RawDbMessage[] = [
      {
        id: "1",
        role: "assistant",
        content: "Did you mean idea #5, or all 5?",
        artifacts: null,
        tool_calls: [
          askToolCall({
            question: "Did you mean idea #5, or all 5?",
            options: ["Just idea #5", "All 5", "Use your best judgment"],
            allowOther: true,
            doneOption: "Use your best judgment",
          }),
        ],
      },
    ];
    const out = hydrate(rows);
    expect(out[0].ask).toBeDefined();
    expect(out[0].ask?.question).toBe("Did you mean idea #5, or all 5?");
    expect(out[0].ask?.options).toEqual([
      "Just idea #5",
      "All 5",
      "Use your best judgment",
    ]);
    expect(out[0].ask?.allowOther).toBe(true);
    expect(out[0].ask?.doneOption).toBe("Use your best judgment");
  });

  test("tool_calls present but no ask_user → no ask reconstructed", () => {
    const rows: RawDbMessage[] = [
      {
        id: "1",
        role: "assistant",
        content: "saved",
        artifacts: null,
        tool_calls: [
          {
            id: "tc",
            type: "function",
            function: { name: "save_voice", arguments: "{}" },
          },
        ],
      },
    ];
    expect(hydrate(rows)[0].ask).toBeUndefined();
  });

  test("malformed JSON args → ask is undefined (UI falls back to prose-only)", () => {
    const rows: RawDbMessage[] = [
      {
        id: "1",
        role: "assistant",
        content: "Q?",
        artifacts: null,
        tool_calls: [
          {
            id: "tc",
            type: "function",
            function: { name: "ask_user", arguments: "{not json" },
          },
        ],
      },
    ];
    expect(hydrate(rows)[0].ask).toBeUndefined();
  });

  test("ask_user with fewer than 2 options → discarded (not a renderable card)", () => {
    const rows: RawDbMessage[] = [
      {
        id: "1",
        role: "assistant",
        content: "Q?",
        artifacts: null,
        tool_calls: [
          askToolCall({ question: "Q?", options: ["only one"] }),
        ],
      },
    ];
    expect(hydrate(rows)[0].ask).toBeUndefined();
  });

  test("allowOther defaults to true unless explicitly false", () => {
    const rows: RawDbMessage[] = [
      {
        id: "1",
        role: "assistant",
        content: "Q?",
        artifacts: null,
        tool_calls: [askToolCall({ question: "Q?", options: ["A", "B"] })],
      },
    ];
    expect(hydrate(rows)[0].ask?.allowOther).toBe(true);

    rows[0].tool_calls = [
      askToolCall({ question: "Q?", options: ["A", "B"], allowOther: false }),
    ];
    expect(hydrate(rows)[0].ask?.allowOther).toBe(false);
  });

  test("a tool row (role:'tool') is filtered out — only user/assistant rendered", () => {
    const rows: RawDbMessage[] = [
      { id: "1", role: "user", content: "hi", artifacts: null },
      { id: "2", role: "tool", content: "{}", artifacts: null },
      { id: "3", role: "assistant", content: "hi back", artifacts: null },
    ];
    const out = hydrate(rows);
    expect(out).toHaveLength(2);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

// ---------------------------------------------------------------------------
// Skill-chip rehydration on user messages. The route persists a synthetic
// _custom_skills_applied entry on the user row's tool_calls when skills were
// active for that send; hydrate extracts the slugs so the bubble shows the
// amber /name chip across reloads. Fixes the "chip vanishes without trace
// after Send" feel — the bubble now keeps the indicator.
// ---------------------------------------------------------------------------
describe("hydrate — re-attaches applied skill slugs to the user message", () => {
  const skillsToolCall = (names: string[]) => ({
    id: "_skills_applied",
    type: "function" as const,
    function: {
      name: "_custom_skills_applied",
      arguments: JSON.stringify({ names }),
    },
  });

  test("user row with the synthetic tool_call → skills attached", () => {
    const rows: RawDbMessage[] = [
      {
        id: "u1",
        role: "user",
        content: "use /cta",
        artifacts: null,
        tool_calls: [skillsToolCall(["cta"])],
      },
    ];
    expect(hydrate(rows)[0].skills).toEqual(["cta"]);
  });

  test("multiple slugs preserve order", () => {
    const rows: RawDbMessage[] = [
      {
        id: "u1",
        role: "user",
        content: "stack two",
        artifacts: null,
        tool_calls: [skillsToolCall(["cta", "newsletter-mention"])],
      },
    ];
    expect(hydrate(rows)[0].skills).toEqual(["cta", "newsletter-mention"]);
  });

  test("user row with NO tool_call → skills undefined (no chip row)", () => {
    const rows: RawDbMessage[] = [
      { id: "u1", role: "user", content: "no skill here", artifacts: null },
    ];
    expect(hydrate(rows)[0].skills).toBeUndefined();
  });

  test("malformed args → skills undefined (silent fallback)", () => {
    const rows: RawDbMessage[] = [
      {
        id: "u1",
        role: "user",
        content: "broken",
        artifacts: null,
        tool_calls: [
          {
            id: "_skills_applied",
            type: "function",
            function: {
              name: "_custom_skills_applied",
              arguments: "{not json",
            },
          },
        ],
      },
    ];
    expect(hydrate(rows)[0].skills).toBeUndefined();
  });

  test("empty names array → skills undefined (don't render an empty chip row)", () => {
    const rows: RawDbMessage[] = [
      {
        id: "u1",
        role: "user",
        content: "empty",
        artifacts: null,
        tool_calls: [skillsToolCall([])],
      },
    ];
    expect(hydrate(rows)[0].skills).toBeUndefined();
  });

  test("assistant row is NEVER given skills (the marker is user-row only)", () => {
    // Defensive: even if the same marker leaked onto an assistant row (it
    // shouldn't), hydrate only attaches skills to user rows.
    const rows: RawDbMessage[] = [
      {
        id: "a1",
        role: "assistant",
        content: "reply",
        artifacts: null,
        tool_calls: [skillsToolCall(["cta"])],
      },
    ];
    expect(hydrate(rows)[0].skills).toBeUndefined();
  });

  // FIRST-LOAD shape: the page Server Component maps rows to initialMessages.
  // It used to DROP tool_calls in that map (even though it SELECTed it), so on a
  // fresh page load the ask-checkboxes + /skill badge vanished and only came
  // back after a chat-switch. This pins the contract: a row that carries
  // tool_calls (as the page now passes through) reconstructs BOTH on hydrate.
  test("a first-load page row WITH tool_calls reconstructs ask AND skills", () => {
    const rows: RawDbMessage[] = [
      {
        id: "u1",
        role: "user",
        content: "use /cta",
        artifacts: null,
        tool_calls: [skillsToolCall(["cta"])],
      },
      {
        id: "a1",
        role: "assistant",
        content: "Which angle?",
        artifacts: null,
        tool_calls: [askToolCall({ question: "Which angle?", options: ["A", "B"] })],
      },
    ];
    const out = hydrate(rows);
    expect(out[0].skills).toEqual(["cta"]); // user bubble badge
    expect(out[1].ask?.options).toEqual(["A", "B"]); // ask checkboxes
  });
});
