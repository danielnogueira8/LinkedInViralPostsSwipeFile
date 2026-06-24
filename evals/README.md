# Agent eval suite

Deterministic regression tests for the chat agent loop. Run with:

```bash
npm run test:evals          # one-shot
npm run test:evals:watch    # watch mode while iterating
```

CI runs this on every PR; a regression blocks merge.

## What it tests

The 20-case suite in `golden-tasks.test.ts` covers two categories:

- **Happy paths** (1–15): the model behaves normally — single tool call,
  multi-tool, hooks list, post draft, cite, conversational reply, render-tool
  calls, etc. Asserts the loop produces the expected artifact / text / tool
  call sequence.
- **Regressions** (16–20): the exact bug patterns we've shipped to production:
  - `#295` — model narrates intent without calling a tool
  - `#297` — loop dead-ends instead of producing an answer
  - `#298` — empty fenced post / invalid cite UUID → blank "Draft" card
  - `#298` — leaked raw fence in displayed text
  - In-band SSE error from streamChat → typed error event with code

Each test fails fast and loudly if the loop ever regresses on those cases.

## How it works (no real model calls)

We **stub `streamChat`** with a deterministic script (see `stub-model.ts` for
the types, `run-agent-test.ts` for the runtime). Each scenario provides a
script of rounds — text the model would emit, tool calls it would make,
finish reason. The stub yields these as `StreamDelta`s to the real
`runAgent` loop.

Tools and the cite resolver are also stubbed (configured per-test via
`setToolResult` / `setCiteResult`), so the suite never touches Supabase /
OpenRouter / LinkedIn.

**Cost: zero.** **Speed: ~1s for the full suite.** **Determinism: total.**

Live-model evals (testing whether GLM-5.2 actually follows the prompt the way
we want) are a separate tier — they'd cost real API tokens per run and need
their own infrastructure. Not implemented yet.

## Adding a new scenario

When a new bug ships, add a regression case here so it can't ship again:

```ts
test("21. <bug-id> — <short description of the bug pattern>", async () => {
  setStubScript({
    rounds: [
      // The model output that triggered the bug.
      { /* ... */ },
    ],
  });
  const t = await runStubbedAgent();
  // Use the assertion helpers in assertions.ts.
  assertNoEmptyTurn(t);
  // ...
});
```

For pre-conditioned tool results:
```ts
setToolResult("get_voice", { ok: false, error: "No voice profile yet." });
```

For pre-conditioned cite resolution:
```ts
setCiteResult("uuid-here", { authorName: "Test Author", text: "Body." });
```

## The six core assertion helpers

`assertions.ts` has the helpers the audit recommended:

| Helper | Catches |
|---|---|
| `assertToolCalled` | Wrong/missing tool call |
| `assertNoEmptyTurn` | The "agent went silent" bug (#295) |
| `assertNoRawFence` | Leaked ``` fenced blocks in displayed text (#298) |
| `assertNoInBandError` | "I reached my tool-use limit" canned text (#297) |
| `assertTurnsUnderLimit` | Runaway loops |
| `assertArtifactKindOk` | Wrong artifact kind / empty-bodied post/hook (#298) |
| `assertTurnDone` | Loop didn't emit a `done` event |
