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

  test("multiSelect round-trips: absent → single-select, true → multi", () => {
    // A single-select ask (the default) has no multiSelect on reload, so the
    // card rehydrates as radios — a reloaded "which idea?" can't become
    // multi-check.
    const single: RawDbMessage[] = [
      {
        id: "1",
        role: "assistant",
        content: "Which idea?",
        artifacts: null,
        tool_calls: [askToolCall({ question: "Which idea?", options: ["A", "B"] })],
      },
    ];
    expect(hydrate(single)[0].ask?.multiSelect).toBeUndefined();

    // The after-draft edit menu persisted multiSelect:true → rehydrates as
    // checkboxes so "shorter" + "add a CTA" can still be picked together.
    const multi: RawDbMessage[] = [
      {
        id: "1",
        role: "assistant",
        content: "What next?",
        artifacts: null,
        tool_calls: [
          askToolCall({
            question: "What next?",
            options: ["Shorter", "Add a CTA", "They're good — done"],
            multiSelect: true,
            doneOption: "They're good — done",
          }),
        ],
      },
    ];
    expect(hydrate(multi)[0].ask?.multiSelect).toBe(true);
  });

  test("an ANSWERED ask (a later user row exists) → card is inert on reload, not re-attached", () => {
    // The bug: hydrate re-attached the interactive card to every ask_user row,
    // so a reloaded answered/dismissed card came back clickable and re-fired a
    // billed turn. It must only stay live when it's the LAST message.
    const rows: RawDbMessage[] = [
      {
        id: "1",
        role: "assistant",
        content: "Which idea?",
        artifacts: null,
        tool_calls: [askToolCall({ question: "Which idea?", options: ["A", "B"] })],
      },
      { id: "2", role: "user", content: "A", artifacts: null },
    ];
    const out = hydrate(rows);
    expect(out[0].ask).toBeUndefined(); // resolved → inert
    // The question text is still stripped so it doesn't reappear as prose.
    expect(out[0].text).not.toContain("Which idea?");
  });

  test("an ask followed by the assistant's own next turn → inert", () => {
    const rows: RawDbMessage[] = [
      {
        id: "1",
        role: "assistant",
        content: "Which angle?",
        artifacts: null,
        tool_calls: [askToolCall({ question: "Which angle?", options: ["A", "B"] })],
      },
      { id: "2", role: "assistant", content: "Here's the draft.", artifacts: null },
    ];
    expect(hydrate(rows)[0].ask).toBeUndefined();
  });

  test("a PENDING ask (the last message) stays live", () => {
    const rows: RawDbMessage[] = [
      { id: "1", role: "user", content: "write something", artifacts: null },
      {
        id: "2",
        role: "assistant",
        content: "Which angle?",
        artifacts: null,
        tool_calls: [askToolCall({ question: "Which angle?", options: ["A", "B"] })],
      },
    ];
    expect(hydrate(rows)[1].ask?.options).toEqual(["A", "B"]);
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
// Recoverable-banner rehydration. A cut-off/stalled turn that still persisted a
// `done` stashes a synthetic _recoverable tool_call on the assistant row; hydrate
// rebuilds `recoverable` so the one-click Continue button survives the reload
// (it was previously live-only and vanished on the post-stream swap).
// ---------------------------------------------------------------------------
describe("hydrate — rebuilds the recoverable Continue banner", () => {
  const recoverableToolCall = (args: Record<string, unknown>) => ({
    id: "_recoverable",
    type: "function" as const,
    function: { name: "_recoverable", arguments: JSON.stringify(args) },
  });

  test("assistant row with a _recoverable marker → recoverable reconstructed", () => {
    const rows: RawDbMessage[] = [
      { id: "u1", role: "user", content: "write a long post", artifacts: null },
      {
        id: "a1",
        role: "assistant",
        content: "Here's the start of your post…",
        artifacts: null,
        tool_calls: [
          recoverableToolCall({
            code: "length_truncated",
            message: "The response was cut off — the model hit its length limit.",
          }),
        ],
      },
    ];
    const out = hydrate(rows);
    expect(out[1].recoverable).toEqual({
      code: "length_truncated",
      message: "The response was cut off — the model hit its length limit.",
      recovery: "continue",
    });
  });

  test("a normal assistant row → no recoverable", () => {
    const rows: RawDbMessage[] = [
      { id: "a1", role: "assistant", content: "all done", artifacts: null },
    ];
    expect(hydrate(rows)[0].recoverable).toBeUndefined();
  });

  test("malformed marker args → recoverable undefined (silent fallback)", () => {
    const rows: RawDbMessage[] = [
      {
        id: "a1",
        role: "assistant",
        content: "x",
        artifacts: null,
        tool_calls: [
          { id: "_recoverable", type: "function", function: { name: "_recoverable", arguments: "{" } },
        ],
      },
    ];
    expect(hydrate(rows)[0].recoverable).toBeUndefined();
  });

  test("marker with an empty message → recoverable undefined (nothing to show)", () => {
    const rows: RawDbMessage[] = [
      {
        id: "a1",
        role: "assistant",
        content: "x",
        artifacts: null,
        tool_calls: [recoverableToolCall({ code: "timeout", message: "" })],
      },
    ];
    expect(hydrate(rows)[0].recoverable).toBeUndefined();
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

describe("hydrate — re-attaches selected post format to the user message", () => {
  const postFormatToolCall = (args: Record<string, unknown>) => ({
    id: "_post_format_selected",
    type: "function" as const,
    function: {
      name: "_post_format_selected",
      arguments: JSON.stringify(args),
    },
  });

  test("uses the persisted label when present", () => {
    const rows: RawDbMessage[] = [
      {
        id: "u1",
        role: "user",
        content: "write a contrarian post",
        artifacts: null,
        tool_calls: [
          postFormatToolCall({
            id: "contrarian_take",
            label: "Contrarian Take",
            forced: true,
          }),
        ],
      },
    ];
    expect(hydrate(rows)[0].postFormat).toBe("Contrarian Take");
  });

  test("falls back to catalog label from id", () => {
    const rows: RawDbMessage[] = [
      {
        id: "u1",
        role: "user",
        content: "write a listicle",
        artifacts: null,
        tool_calls: [postFormatToolCall({ id: "tactical_listicle", forced: true })],
      },
    ];
    expect(hydrate(rows)[0].postFormat).toBe("Tactical Listicle");
  });

  test("malformed args → postFormat undefined", () => {
    const rows: RawDbMessage[] = [
      {
        id: "u1",
        role: "user",
        content: "write a post",
        artifacts: null,
        tool_calls: [
          {
            id: "_post_format_selected",
            type: "function",
            function: { name: "_post_format_selected", arguments: "{" },
          },
        ],
      },
    ];
    expect(hydrate(rows)[0].postFormat).toBeUndefined();
  });
});
