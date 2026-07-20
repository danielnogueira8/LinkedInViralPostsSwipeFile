# Agent eval suite

Deterministic regression tests for the chat turn pipeline and its focused
modules. Run with:

```bash
npm run test:evals          # one-shot
npm run test:evals:watch    # watch mode while iterating
```

CI runs this on every PR; a regression blocks merge.

## What it tests

The suite in `evals/data/` covers two categories:

- **Data-layer / focused-module tests** — deterministic assertions against
  isolated functions: tool queries, routing, prompt assembly, telemetry,
  draft-engine behavior, output policy, and migration contracts.
- **Integration tests** — end-to-end chat turn scenarios using stubbed
  dependencies (no real model calls or external APIs).

The legacy `runAgent` / `decideTurn` loop evals and the live-model / Promptfoo
prompt-contract tiers were removed in Step 10 of the cowork unification plan.
Key prompt-threading assertions (custom skills, no-model formats, content
feedback) were ported to `evals/data/draft-engine.test.ts`.

## Tier 1: data-layer tests (`evals/data/`)

This tier tests the queries and focused modules themselves: which column a tool
filters on, ordering, limit clamps, tenant scoping, and how the result is
shaped.

That's exactly where the "top from latest scrape" recency bug lived
(`get_top_from_batch` filtered `scraped_at` instead of `posted_at`), and where
this class of bug always lives — below the model, cheap and fully deterministic.
`evals/data/tools-query.test.ts` includes the **Klaus regression guard**: it
asserts `get_top_from_batch` filters on `posted_at` and never on `scraped_at`.
Reintroduce the old filter and that test fails loudly — verified.

How it works: `supabaseAdmin()` is mocked with a fake query builder
(`fake-supabase.ts`) that RECORDS the chained calls (`.from().eq().gte()…`) and
returns canned rows, and `trackedAccountIds()` is mocked with fixed ids. No DB,
no API. Part of the default hermetic suite (`npm run test:evals`).

When you add or change a tool query, add a case here pinning the column /
ordering / clamp it must use.

## Adding a new scenario

When a new bug ships, add a regression case in the appropriate `evals/data/`
file so it can't ship again. Prefer focused module tests over end-to-end loop
mechanics whenever the bug lives in a single function.
