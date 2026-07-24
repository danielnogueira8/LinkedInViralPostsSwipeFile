# Anthropic adapter — remaining compatibility gaps (audit)

Found by a vocabulary/shape audit after the finishReason fix (#1460). The adapter
returns Anthropic-shaped values that some callers consume assuming OpenRouter
shape. `finishReason` (mapped via `mapStopReason`), `toolArgs`, streamed
tool-calls, and file attachments are all verified NON-issues.

## SEV 1 — broken user-facing flows (web search)

Both stem from: OpenRouter does web search via a `plugins:[{id:"web"}]` param and
returns grounded sources as `citations` (url_citation annotations). The adapter
**ignores `plugins`** and **always returns `citations:[]`**. Anthropic does web
search via a **server tool** (`web_search_20260209`) returning result content
blocks — the adapter bridges neither.

1. **News search dead** — `lib/news-search.ts:178-203,255,263`. `plugins:[{id:"web"}]`
   + reads `discovery.citations`. Default model `anthropic/claude-haiku-4.5`
   routes to the adapter under the flag → no search → `{results:[], searched:0}`.
2. **Grounded web-research throws** — `lib/agent/execute/agent.ts:3604-3663`.
   Requires `candidate.citations`; empty → throws `InvalidAdapterResponseError`,
   fails closed. `PRIMARY_WEB_RESEARCH_MODEL = CHAT_MODEL` (Claude under flag).

**Chosen fix: native Anthropic web search** — teach the adapter Anthropic's
`web_search` server tool when `plugins` contains `{id:"web"}`, and populate
`citations` from the web-search result blocks.

## SEV 2 — cost / telemetry misreporting

2a. **Bare Claude ids mis-priced** — adapter returns bare `claude-haiku-4.5`;
   `OPENROUTER_PRICING` only has bare `claude-sonnet-5` (+ prefixed forms) →
   Haiku falls back to the GLM-5.1 rate. Wrong cost-cap accounting for non-Sonnet
   Claude. FIX: add bare Claude pricing rows (or normalize to prefixed before
   pricing lookup). `lib/openrouter.ts:1139` `openRouterCost` fallback;
   `lib/agent/cowork-adapter-attempt.ts:10-19` prefers the served (bare) model.

2b. **`reasoning_tokens` always 0** — `mapUsage` never sets
   `completion_tokens_details`. Cost is correct (Anthropic folds thinking into
   `output_tokens`); telemetry only. Low priority.

2c. **Per-attempt telemetry hardcodes `provider:"openrouter"`** —
   `cowork-adapter-attempt.ts:115,149`, `turn/execute.ts:718,737`. The
   authoritative `usage_events.provider` column IS correct (uses
   `shouldUseAnthropic`), so cost split is right. Cosmetic.

## Verified NON-issues
finishReason (fully mapped), toolArgs (forced single-tool, parsed object),
StreamDelta.toolCalls/fileAnnotations (never consumed), file attachments
(converted to native `document` blocks), `lib/usage.ts` anthropicCost (dead
code, no callers), usage.cost readers (fallback path is correct).

## Sequencing
- PR: native Anthropic web search (SEV 1) — IN PROGRESS.
- PR: pricing rows + telemetry provider/reasoning (SEV 2) — queued.
