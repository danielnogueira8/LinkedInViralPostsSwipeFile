# Agent eval suite

Deterministic regression tests for the chat agent loop. Run with:

```bash
npm run test:evals          # one-shot
npm run test:evals:watch    # watch mode while iterating
npm run test:prompts        # live GLM-5.2 prompt contracts (Promptfoo)
```

CI runs this on every PR; a regression blocks merge.

## Promptfoo contract matrix

`evals/promptfoo/` exercises the production `SYSTEM_PROMPT` directly against
GLM-5.2 through OpenRouter. It extracts the prompt from `lib/agent/run.ts` at
runtime, so edits to the real prompt are evaluated without a copied fixture.

The matrix covers deterministic, text-only contracts that do not require the
agent tool loop: exact-count formatting, fixed product scope, untrusted-source
prompt-injection resistance, no invented business facts, and no narration of
internal mechanics. These checks complement the tool-stubbed live Vitest suite
below; they do not replace its end-to-end agent/tool assertions.

Because Promptfoo does not register the app's workspace tools, the harness adds
a capability-only system notice telling the model that tools are unavailable
and to answer directly. It does not restate or strengthen the production
prompt's scope, safety, truthfulness, or formatting rules.

The run is opt-in because it makes paid requests. It reads
`OPENROUTER_API_KEY` from `.env.local`, uses `z-ai/glm-5.2`, disables Promptfoo
cache, and never places credentials in the config or exported results. The
pinned Promptfoo release requires Node 20.20+ or 22.22+.

## What it tests

The suite in `golden-tasks.test.ts` (Tier 2) covers two categories:

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

## Tier 1: data-layer tests (`evals/data/`)

Both suites above sit ABOVE the tool queries — they take tool output as given.
This tier tests the queries THEMSELVES: which column a tool filters on, the
ordering, the limit clamps, tenant scoping, and how it shapes the result.

That's exactly where the "top from latest scrape" recency bug lived
(`get_top_from_batch` filtered `scraped_at` instead of `posted_at`), and where
this class of bug always lives — below the model, cheap and fully
deterministic. `evals/data/tools-query.test.ts` includes the **Klaus regression
guard**: it asserts `get_top_from_batch` filters on `posted_at` and never on
`scraped_at`. Reintroduce the old filter and that test fails loudly — verified.

How it works: `supabaseAdmin()` is mocked with a fake query builder
(`fake-supabase.ts`) that RECORDS the chained calls (`.from().eq().gte()…`) and
returns canned rows, and `trackedAccountIds()` is mocked with fixed ids. No DB,
no API. Part of the default hermetic suite (`npm run test:evals`).

When you add or change a tool query, add a case here pinning the column /
ordering / clamp it must use.

## Tier 3: live-model prompt evals (`evals/live/`)

The stubbed suite above tests loop *mechanics* — given a scripted model output,
does the loop behave? It can't test whether the model **follows the system
prompt**, because the model is stubbed. That's a real gap: e.g. after the
"top from latest scrape" recency fix, the data is correct, but nothing verified
the model actually *states the scrape date* instead of implying an old post is
new.

`evals/live/prompt-evals.live.test.ts` closes that gap:

- Runs the **real** agent loop against the **real** chat model (GLM via
  OpenRouter) — so prompt-following is genuinely exercised.
- **Stubs the tools** with fixed fixtures — so the DATA is deterministic while
  the REASONING is real.
- Grades each case with an **LLM judge** (Claude, via the Anthropic SDK — a
  different model from the one under test, so nothing grades itself), because
  these properties are fuzzy ("did it imply the post is newer than it is?").
  The judge **fails closed**: any parse/SDK error is a FAIL, never a false green.

Each case asserts ONE prompt rule: date honesty, exact-count adherence,
voice-profile-required, no-internal-narration.

### Running

```bash
npm run test:evals:live
```

This is **opt-in and NOT part of CI by default** — it costs real API tokens and
is mildly non-deterministic. It runs only when `RUN_LIVE_EVALS=1` **and**
`OPENROUTER_API_KEY` is present — the ONLY key needed, since both the model
under test and the LLM judge run through OpenRouter; otherwise every case
**skips cleanly** (so it can never break a normal run). Intended for nightly /
pre-release runs. The key loads from `.env.local` via `evals/live/setup.ts`.

### Adding a prompt-rule case

When you add or change a system-prompt rule, add a case that proves the model
obeys it: set tool fixtures, send a user message, and judge the visible
deliverable against the rule in one sentence. See the existing four for the
pattern.

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
