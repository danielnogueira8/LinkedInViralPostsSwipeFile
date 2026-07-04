import { describe, test, expect } from "vitest";
import {
  consumeSSE,
  hydrate,
  runOverlay,
  sameFiles,
  shouldApplyAskTurnReload,
  type ChatRun,
  type Message,
  type RawDbMessage,
} from "@/app/(app)/dashboard/chat-workspace";
import { stripArtifactFences } from "@/lib/agent/run";

// ---------------------------------------------------------------------------
// The SSE frame parser + the optimistic-message overlay — client logic that
// every streamed turn flows through, previously untested (it lived inside the
// component module). A parser bug here corrupts every message; an overlay bug
// double-renders the user's turn on a switch-away-and-back.
// ---------------------------------------------------------------------------

// Build a ReadableStream<Uint8Array> from a list of string chunks, so we can
// control exactly where the byte stream splits (mid-frame, mid-value, etc).
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
}

// Collect the (event, data) callbacks consumeSSE fires.
async function collect(
  chunks: string[],
  signal?: AbortSignal,
): Promise<{ event: string; data: Record<string, unknown> }[]> {
  const out: { event: string; data: Record<string, unknown> }[] = [];
  await consumeSSE(streamOf(chunks), (event, data) => out.push({ event, data }), signal);
  return out;
}

describe("consumeSSE — frame parsing", () => {
  test("parses a simple event/data frame", async () => {
    const out = await collect(['event: text\ndata: {"delta":"hi"}\n\n']);
    expect(out).toEqual([{ event: "text", data: { delta: "hi" } }]);
  });

  test("reassembles a frame split across read() chunk boundaries", async () => {
    // The JSON value is split mid-string across two chunks; consumeSSE buffers
    // until the \n\n frame terminator, so the value must come through intact.
    const out = await collect([
      'event: text\ndata: {"delta":"line',
      ' 1"}\n\n',
    ]);
    expect(out).toEqual([{ event: "text", data: { delta: "line 1" } }]);
  });

  test("handles multiple frames in one chunk", async () => {
    const out = await collect([
      'event: text\ndata: {"delta":"a"}\n\nevent: text\ndata: {"delta":"b"}\n\n',
    ]);
    expect(out.map((o) => o.data.delta)).toEqual(["a", "b"]);
  });

  test("a frame split exactly at the \\n\\n boundary across chunks still fires once", async () => {
    const out = await collect(['event: done\ndata: {"ok":true}\n', "\n"]);
    expect(out).toEqual([{ event: "done", data: { ok: true } }]);
  });

  test("ignores a malformed (non-JSON) data payload without throwing", async () => {
    const out = await collect([
      "event: text\ndata: not-json\n\n" + 'event: text\ndata: {"delta":"ok"}\n\n',
    ]);
    // The bad frame is dropped; the good one still fires.
    expect(out).toEqual([{ event: "text", data: { delta: "ok" } }]);
  });

  test("an already-aborted signal yields nothing", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const out = await collect(['event: text\ndata: {"delta":"hi"}\n\n'], ctrl.signal);
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

function mkRun(over: Partial<ChatRun> & { userMsg: Message }): ChatRun {
  return {
    assistantId: "a_1",
    rawText: "",
    tools: [],
    plan: [],
    artifacts: [],
    streaming: true,
    ctrl: new AbortController(),
    ...over,
  };
}

describe("runOverlay — optimistic user-message dedupe", () => {
  const userMsg: Message = { id: "u_1", role: "user", text: "write me a hook" };

  test("with an empty base, renders the optimistic user msg + the streaming assistant", () => {
    const out = runOverlay(mkRun({ userMsg }), []);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(out[0].text).toBe("write me a hook");
    expect(out[1].streaming).toBe(true);
  });

  test("dedupes the optimistic user msg when the refetched base already ends with it", () => {
    // Switch-away-and-back: the server persisted the user row, loadChat refetched
    // it, but the run is still streaming — the optimistic copy must NOT duplicate.
    const base: Message[] = [
      { id: "db-uuid", role: "user", text: "write me a hook" },
    ];
    const out = runOverlay(mkRun({ userMsg }), base);
    // Only the assistant overlay is added; the user msg isn't doubled.
    expect(out.map((m) => m.role)).toEqual(["assistant"]);
  });

  test("keeps the optimistic copy when the base's last user msg differs", () => {
    const base: Message[] = [
      { id: "db-uuid", role: "user", text: "a DIFFERENT earlier message" },
    ];
    const out = runOverlay(mkRun({ userMsg }), base);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  test("dedupes even when base ENDS with the assistant row (run not yet dropped)", () => {
    // The race window: a reload landed the assistant row into base while the run
    // is still present (a follow-up send, or loadChat racing send()'s swap). base
    // now ends with the ASSISTANT, so checking only base[last] would MISS the
    // match and double the user bubble. Scanning the last USER row still dedupes.
    const base: Message[] = [
      { id: "db-uuid-user", role: "user", text: "write me a hook" },
      { id: "db-uuid-asst", role: "assistant", text: "Here's a hook…" },
    ];
    const out = runOverlay(mkRun({ userMsg }), base);
    // The optimistic user copy is dropped (already in base); only the overlay
    // assistant is added — no doubled user bubble.
    expect(out.map((m) => m.role)).toEqual(["assistant"]);
  });

  test("only post/hook cites... only cite artifacts ride on the assistant message", () => {
    const run = mkRun({
      userMsg,
      rawText: "here you go",
      artifacts: [
        { id: "p1", kind: "post", title: "P", body: "a post" },
        { id: "c1", kind: "cite", title: "src", body: "", meta: { postId: "x" } },
      ],
    });
    const out = runOverlay(run, []);
    const assistant = out[out.length - 1];
    // Post/hook drafts live in the panel, NOT inline; only cites attach.
    expect((assistant.artifacts ?? []).map((a) => a.kind)).toEqual(["cite"]);
  });

  // The ask_user fix: a SETTLED (non-streaming) run that ended on a clarifying
  // question must render the question text + the ask on the assistant message,
  // so the AskCard's gate `message.ask && !message.streaming` is satisfied. (The
  // question arrives via the `ask` EVENT, not as streamed rawText, so rawText is
  // empty — the overlay must surface ask.question as the text.)
  const ask = { question: "Idea #5, or all 5?", options: ["#5", "All 5"], allowOther: true };

  test("a settled ask-run renders the question text + the ask, with streaming false", () => {
    const run = mkRun({ userMsg, rawText: "", ask, streaming: false });
    const assistant = runOverlay(run, [])[1];
    expect(assistant.ask).toEqual(ask);
    expect(assistant.streaming).toBe(false); // gate: !streaming → card shows
    expect(assistant.text).toBe("Idea #5, or all 5?"); // question surfaced as text
  });

  test("real streamed text still wins over the ask question for the bubble text", () => {
    const run = mkRun({ userMsg, rawText: "Here's my reasoning…", ask, streaming: false });
    const assistant = runOverlay(run, [])[1];
    expect(assistant.text).toBe("Here's my reasoning…");
    expect(assistant.ask).toEqual(ask); // ask still attached
  });

  test("no ask → no ask on the message, text from rawText", () => {
    const run = mkRun({ userMsg, rawText: "a normal reply", streaming: false });
    const assistant = runOverlay(run, [])[1];
    expect(assistant.ask).toBeUndefined();
    expect(assistant.text).toBe("a normal reply");
  });
});

// The post-stream "reload flicker" fix. `messages` is assembled as
// [...base, ...runOverlay(run, base)] (chat-workspace.tsx). When a turn ends,
// the live run must be swapped for the canonical DB base WITHOUT a frame where
// the just-finished assistant reply is absent (the old delete-then-reload bug)
// or doubled (a reload-then-delete-with-two-bumps bug). These model the two
// states the swap transitions between and assert the reply count is always 1.
describe("post-stream handoff — reply present exactly once, never 0 or 2", () => {
  const userMsg: Message = { id: "u_opt", role: "user", text: "draft a hook" };
  // The settled run still holding the just-finished reply (streaming:false).
  const settledRun = mkRun({
    userMsg,
    assistantId: "a_opt",
    rawText: "Here's your hook.",
    streaming: false,
  });
  // assemble() mirrors the component's `messages` computation.
  const assemble = (run: ChatRun | null, base: Message[]) => [
    ...base,
    ...(run ? runOverlay(run, base) : []),
  ];
  const assistantCount = (msgs: Message[]) =>
    msgs.filter((m) => m.role === "assistant").length;

  test("BEFORE the swap (run alive, base = pre-turn) → reply shows once via the overlay", () => {
    // Base still has only the user row the server persisted at turn start.
    const preTurnBase: Message[] = [
      { id: "db-u", role: "user", text: "draft a hook" },
    ];
    const msgs = assemble(settledRun, preTurnBase);
    expect(assistantCount(msgs)).toBe(1);
    expect(msgs[msgs.length - 1].text).toBe("Here's your hook.");
  });

  test("AFTER the swap (run dropped, base = reloaded) → reply shows once via base", () => {
    // The reload brought back the full canonical turn (user + assistant).
    const reloadedBase: Message[] = [
      { id: "db-u", role: "user", text: "draft a hook" },
      { id: "db-a", role: "assistant", text: "Here's your hook." },
    ];
    const msgs = assemble(null, reloadedBase);
    expect(assistantCount(msgs)).toBe(1);
  });

  test("the FORBIDDEN intermediate (run dropped BEFORE base has the turn) → reply MISSING — this was the flicker", () => {
    // Documents the OLD bug: deleting the run while base is still pre-turn drops
    // the reply to zero for the reload round-trip. The fix avoids ever rendering
    // this state by keeping the run until the reload lands.
    const preTurnBase: Message[] = [
      { id: "db-u", role: "user", text: "draft a hook" },
    ];
    const msgs = assemble(null, preTurnBase);
    expect(assistantCount(msgs)).toBe(0); // the flicker — must never be rendered
  });

  test("the OTHER forbidden state (run kept AND base already reloaded) → reply DOUBLED", () => {
    // Documents why we can't just reload-first-then-delete with two bumps: the
    // overlay's assistant (id a_opt) + the base's assistant (id db-a) both show.
    const reloadedBase: Message[] = [
      { id: "db-u", role: "user", text: "draft a hook" },
      { id: "db-a", role: "assistant", text: "Here's your hook." },
    ];
    const msgs = assemble(settledRun, reloadedBase);
    expect(assistantCount(msgs)).toBe(2); // why the swap must be a single bump
  });
});

// Bug 2 — "the chat history disappeared when I answered the question." When a
// turn ended on ask_user, the OLD code kept the ask-RUN alive as the sole
// source of that turn's rows (user msg + question card) and never refreshed
// `base`. The instant the user answered, their send OVERWROTE runsByChat for
// this chat (the ask-run is gone), so those two rows — which lived only in the
// ask-run's overlay — blinked out until the ANSWER turn's own post-stream
// reload eventually ran. The fix folds the persisted ask turn into `base` when
// the ask turn ends (hydrate rebuilds the AskCard from the persisted ask_user
// tool_call), so the question + card render from base and survive the swap.
//
// These model `messages = [...base, ...runOverlay(answerRun, base)]` for BOTH
// the old (ask turn NOT in base) and fixed (ask turn IN base) states, and pin
// that after the fix the drafting request + its clarifying question remain.
describe("ask-answer handoff — the answered turn's history must NOT vanish", () => {
  // The prior transcript: the user got 5 ideas, then asked to draft #5, and the
  // agent ended the turn on a clarifying question (persisted as an ask_user
  // tool_call → hydrate reconstructs the card).
  const askTurnRows: RawDbMessage[] = [
    { id: "u-ideas", role: "user", content: "give me 5 post ideas", artifacts: null },
    { id: "a-ideas", role: "assistant", content: "1. …\n2. …\n3. …\n4. …\n5. …", artifacts: null },
    { id: "u-draft5", role: "user", content: "Draft post 5 only", artifacts: null },
    {
      id: "a-ask",
      role: "assistant",
      content: "I only see 4 ideas — which did you mean?",
      artifacts: null,
      tool_calls: [
        {
          id: "tc_ask",
          type: "function",
          function: {
            name: "ask_user",
            arguments: JSON.stringify({
              question: "I only see 4 ideas — which did you mean?",
              options: ["Idea 4", "Idea 3", "Use your best judgment"],
              allowOther: true,
            }),
          },
        },
      ],
    },
  ];
  // The user answers; their send registers a fresh run (the ask-run is gone).
  const answerRun = mkRun({
    userMsg: { id: "u_ans", role: "user", text: "Idea 4" },
    assistantId: "a_ans",
    rawText: "",
    streaming: true,
  });
  const assemble = (run: ChatRun | null, base: Message[]) => [
    ...base,
    ...(run ? runOverlay(run, base) : []),
  ];

  test("OLD (buggy) state — ask turn NOT folded into base → the draft request + question VANISH", () => {
    // Base is stuck at the PRE-ask-turn transcript (5 ideas only); the ask
    // turn's rows lived only in the now-overwritten ask-run.
    const preAskBase = hydrate(askTurnRows.slice(0, 2));
    const msgs = assemble(answerRun, preAskBase);
    const texts = msgs.map((m) => m.text);
    // The regression: neither the drafting request nor the clarifying question
    // is on screen anymore.
    expect(texts).not.toContain("Draft post 5 only");
    expect(msgs.some((m) => m.ask)).toBe(false);
  });

  test("FIXED state — ask turn folded into base → the draft request + question card SURVIVE", () => {
    // The fix reloaded the full persisted turn into base before the swap.
    const foldedBase = hydrate(askTurnRows);
    const msgs = assemble(answerRun, foldedBase);
    const texts = msgs.map((m) => m.text);
    // The whole history is intact: the 5-idea exchange, the draft request, the
    // clarifying question (with its card), AND the new answer bubble.
    expect(texts).toContain("give me 5 post ideas");
    expect(texts).toContain("Draft post 5 only");
    expect(texts).toContain("Idea 4"); // the answer just sent
    // The AskCard still renders: the ask survives on the base assistant row and
    // that row is NOT streaming (base rows never are), satisfying the card gate
    // `message.ask && !message.streaming`.
    const askMsg = msgs.find((m) => m.ask);
    expect(askMsg).toBeDefined();
    expect(askMsg?.streaming).toBeFalsy();
    expect(askMsg?.ask?.options).toEqual(["Idea 4", "Idea 3", "Use your best judgment"]);
    // And the answer bubble isn't a duplicate — runOverlay keeps the optimistic
    // user copy since base's last user row ("Draft post 5 only") differs from it.
    expect(msgs.filter((m) => m.role === "user" && m.text === "Idea 4")).toHaveLength(1);
  });

  test("fast answer race — ask reload still applies after the answer run replaced the ask run", () => {
    const preAskBase = hydrate(askTurnRows.slice(0, 2));
    const askReload = hydrate(askTurnRows);

    expect(shouldApplyAskTurnReload(preAskBase, askReload)).toBe(true);

    const msgs = assemble(answerRun, askReload);
    expect(msgs.map((m) => m.text)).toContain("Draft post 5 only");
    expect(msgs.some((m) => m.ask)).toBe(true);
    expect(msgs.filter((m) => m.role === "user" && m.text === "Idea 4")).toHaveLength(1);
  });

  test("stale ask reload does not overwrite a newer base that already has the answer", () => {
    const askReload = hydrate(askTurnRows);
    const newerBase = hydrate([
      ...askTurnRows,
      { id: "u-answer", role: "user", content: "Idea 4", artifacts: null },
      {
        id: "a-answer",
        role: "assistant",
        content: "Done — I drafted idea 4.",
        artifacts: null,
      },
    ]);

    expect(shouldApplyAskTurnReload(newerBase, askReload)).toBe(false);
  });
});

describe("sameFiles", () => {
  test("both absent → equal", () => {
    expect(sameFiles(undefined, undefined)).toBe(true);
  });
  test("one absent → not equal", () => {
    expect(sameFiles(["a.txt"], undefined)).toBe(false);
  });
  test("same contents in order → equal", () => {
    expect(sameFiles(["a.txt", "b.pdf"], ["a.txt", "b.pdf"])).toBe(true);
  });
  test("different order → not equal", () => {
    expect(sameFiles(["a.txt", "b.pdf"], ["b.pdf", "a.txt"])).toBe(false);
  });
  test("different length → not equal", () => {
    expect(sameFiles(["a.txt"], ["a.txt", "b.pdf"])).toBe(false);
  });
});

describe("stripArtifactFences (server-side persisted-content cleanup)", () => {
  test("removes a ```post fence but keeps surrounding prose", () => {
    const text = "Here's a draft:\n\n```post\nThe body\n```\n\nLet me know.";
    const out = stripArtifactFences(text);
    expect(out).not.toContain("```");
    expect(out).toContain("Here's a draft:");
    expect(out).toContain("Let me know.");
  });

  test("removes hook and cite fences too", () => {
    expect(stripArtifactFences("a\n```hook\nx\n```\nb")).toBe("a\n\nb");
    expect(stripArtifactFences("a\n```cite\nuuid\n```\nb")).toBe("a\n\nb");
  });

  test("collapses the blank lines a removed fence leaves behind", () => {
    const out = stripArtifactFences("intro\n\n```post\nbody\n```\n\n\n\noutro");
    expect(out).not.toMatch(/\n{3,}/);
  });

  test("leaves prose that merely mentions code untouched (no fence)", () => {
    const text = "I renamed it to `sendDraft` and it worked.";
    expect(stripArtifactFences(text)).toBe(text);
  });
});
