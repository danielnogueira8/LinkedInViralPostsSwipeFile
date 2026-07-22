# Cowork v2 failure-injection matrix

This matrix pins the failure classes that must never produce a blank turn, leak
a partial deliverable, replay a committed mutation, or silently bypass fallback.
The named tests execute the real route engines with scripted adapters and durable
checkpoint doubles; they are not prompt-only assertions.

| Injected fault | Executed coverage | Required terminal behavior |
| --- | --- | --- |
| First-token timeout | `DraftEngine > falls back to GLM after primary timeout`; `failure injection telemetry records timeout fallback and a delivered contract` | Cross-provider fallback delivers one finalized artifact and records the timeout. |
| Mid-stream disconnect | `DraftEngine > falls back to GLM after primary mid-stream disconnect`; `read-only orchestrator > a writer exception persists completed research without exposing a partial artifact` | Fallback succeeds before delivery, or a typed recoverable terminal is persisted with no leaked artifact. |
| Invalid planner schema | `read-only orchestrator > switches from malformed Sonnet output to Gemini before dispatching any action`; action-plan parser rejection tests | The invalid adapter is charged, marked unhealthy, and replaced before any action runs. |
| Wrong or repeated action | `action orchestrator contract > rejects unknown targets, altered requirements, and semantic duplicates`; `a malformed tool plan counts as an adapter failure and opens its circuit` | No checkpoint is claimed from an invalid plan; fallback must recompile the exact authorized action set. |
| Provider 429 | `DraftEngine > falls back to GLM after primary provider 429`; real `completeChat` HTTP-status injection | The attempt is classified as `rate_limit`, affects adapter health, and uses fallback. |
| Provider 5xx | `DraftEngine > falls back to GLM after primary provider 503`; real `completeChat` HTTP-status injection | The attempt is classified as `provider_5xx`, affects adapter health, and uses fallback. |
| Empty output | `DraftEngine > falls back to GLM after primary empty output` | Empty text is rejected and can never become the terminal assistant response. |
| Truncated output | `DraftEngine > repairs a truncated primary candidate without presenting it`; content-filter truncation test | The incomplete prefix stays buffered; repair or fallback must pass finalization before delivery. |
| Finalizer rejection | fixed-source fidelity rejection, incomplete repair, duplicate multi-draft, and source-claim tests | A rejection produces one bounded repair and then cross-provider fallback; rejected text never escapes. |
| Cancellation before planner | action and read-only route cancellation tests | No tool dispatch or checkpoint claim; terminal reason is `cancelled`. |
| Cancellation during writer | `DraftEngine > cancellation stops repair and fallback`; multi-child cancellation tests | No artifact and no extra provider spend after cancellation. |
| Cancellation during finalizer | `DraftEngine > cancellation during finalization emits no artifact and never spends on fallback` | No artifact and no fallback after the finalizer observes cancellation. |
| Cancellation around action checkpoints | action cancellation, atomic-execute tombstone, lease release, and partial-claim reset tests | Committed work is never replayed; uncommitted work is durably cancelled or left retryable. |
| Fallback before checkpoint | malformed-plan fallback and open-primary-circuit tests | Planner fallback completes before the first checkpoint claim. |
| Fallback after checkpoint | `provider fallback resumes a committed checkpoint without replaying the mutation`; lost execute-response reconciliation | A terminal checkpoint is authoritative; no planner or mutation is replayed. |
| Per-stage timeout | provider timeout tests for writers, planners, web research, and attachment inspection | The current adapter aborts and fallback remains bounded by the route deadline. |
| Cancellation during provider retry or retrieval | `openrouter-retry.test.ts` response/network backoff tests; `exemplar-rpc-cancellation.test.ts`; exemplar body-query signal test | Retry sleeps abort immediately; exemplar match and body queries bind the turn signal and never outlive Stop/deadline. |
| End-to-end deadline | single and multi draft deadlines; action and read-only route-wide deadline tests | The turn ends with a typed nonblank `deadline` or recoverable terminal and no partial delivery. |
| Circuit opens and recovers | `adapter-health.test.ts`; direct, action, read-only, and finalizer hot-circuit tests | Rolling error/latency windows open the circuit, bind recovery to the actual probe permit, and require consecutive healthy probes before closing. |
| Hidden finalizer adapter failure | AI-tell repair, sameness, and source-fidelity specialist tests | Every paid finalizer call shares the same health, validation, usage, and telemetry boundary as writers and planners. |
| Hidden pre-generation helper failure | freshness cache-miss, backstory telemetry, and exemplar-retrieval tests | Paid freshness, backstory, and exemplar-embedding calls share the adapter boundary; provider/content failures remain visible while authoritative usage failures stop the turn. Backstory caches no-facts only after a schema-valid empty response. One query embedding is reused for both exemplar RPCs. |
| Grounded news normalization failure | `news-search.test.ts` discovery-before-normalization failure and safe-metadata assertions; `search-news-tool.test.ts` ledger failure | Discovery and normalization are independent paid attempts. Discovery usage persists before normalization begins, both affect health/telemetry, ledger failures stop the turn, and no query text enters usage metadata. |
| Vision analysis unavailable | `chat-stream-preflight.test.ts` failed-image marker; attachment evidence tests | A failed or skipped image is explicitly marked not described and can never become verified attachment evidence. |
| Checkpoint infrastructure failure | `action-orchestrator.test.ts` database-stage assertions and checkpoint fault tests | List, claim, execute, cancel, reset, release, and reconciliation stages record safe outcomes without IDs, leases, or arguments. |
| Research or saved-draft lookup failure | read-only direct-search stage tests; action `list_drafts` stage tests | Non-model server/database stages report safe latency and reason codes without query results, ids, or arguments. |
| Legacy route accounting | `content-feedback-runagent.test.ts` legacy-stage assertion | Legacy Cowork still reports its aggregate model, tokens, cache use, cost, latency, and terminal stage outcome. |
| Setup failure before route finalization | `chat-stream-preflight.test.ts` post, research, and action contract cases | Claim-time records preserve the requested contract even if setup is cancelled before the final route is known. |
| Telemetry leakage, duplicate finish, or long-turn cap | `cowork-telemetry.test.ts` | One safe structured record is emitted; prompts, bodies, credentials, and reasoning are never accepted; bounded detail never truncates aggregate cost. |
| Cost/rate-limit storage failure | adapter-attempt ledger failure, editor ledger failure, `rate-limit.test.ts`, `rate-limit-claim-error.test.ts`, `read-only-cost-claim.test.ts`, `usage-log-drop.test.ts` | Reservations and usage accounting fail closed; the paid attempt remains observable and no uncharged fallback spend is allowed. |

Run the focused matrix with:

```bash
pnpm vitest run \
  evals/data/adapter-health.test.ts \
  evals/data/cowork-adapter-attempt.test.ts \
  evals/data/cowork-telemetry.test.ts \
  evals/data/backstory-telemetry.test.ts \
  evals/data/draft-engine.test.ts \
  evals/data/action-orchestrator.test.ts \
  evals/data/read-only-orchestrator.test.ts \
  evals/data/agent-editor.test.ts \
  evals/data/ai-tell-repair.test.ts \
  evals/data/sameness-detector.test.ts \
  evals/data/source-fidelity.test.ts \
  evals/data/content-feedback-runagent.test.ts \
  evals/data/news-search.test.ts \
  evals/data/search-news-tool.test.ts \
  evals/data/exemplar-retrieval.test.ts \
  evals/data/exemplar-rpc-cancellation.test.ts \
  evals/data/openrouter-provider-routing.test.ts \
  evals/data/rate-limit.test.ts \
  evals/data/rate-limit-claim-error.test.ts \
  evals/data/read-only-cost-claim.test.ts \
  evals/data/usage-log-drop.test.ts
```
