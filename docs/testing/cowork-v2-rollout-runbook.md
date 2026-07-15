# Cowork v2 rollout gate

Global rollout is fail-closed. A green deterministic suite proves that the
server-owned route, persistence, contract, finalizer, and checkpoint seams are
stable under scripted provider outcomes. It does **not** prove live model
quality, actual charged cost, provider latency, or browser behavior.

## Promotion requirements

The report in `lib/agent/cowork-rollout-evidence.ts` blocks promotion until all
of these are true:

- Every critical journey has at least 300 contract-correct, production-shaped
  baseline completions and 300 contract-correct v2 completions. Attempts that
  cancel unexpectedly, recover without completing the tested journey, or fail
  their contract do not count toward 300.
- Every critical journey has at least 300 provider-observed cost records for
  each architecture. Fixture prices do not count.
- Reliability, fallback, and latency comparisons include every live,
  production-shaped attempt, including timeouts and failures with no provider
  usage record. Charged-cost totals and means use only live records where the
  provider reported cost. Scripted runs remain diagnostic and can expose hard
  failures, but never dilute live regression metrics.
- V2 has zero user-visible hard failures.
- V2 does not regress contract pass rate, fallback rate, p95 latency, or mean
  charged cost versus the hardened baseline.
- Direct writing stays at or below 30 seconds p95. Research/action journeys
  stay at or below 60 seconds p95 and 90 seconds p99.
- Each writing class has at least 20 blinded comparisons and v2 matches or
  beats baseline on usefulness, voice, factuality, completeness, and
  preference.
- Both model-order experiments have enough matched evidence to produce a
  recommendation. Bundled Sonnet+Qwen versus Gemini+GLM runs never count as a
  model-order experiment.
- Authenticated desktop and mobile Cowork checks are both marked passed.

The writing classes are original, refine, fixed source, partial, multi-post,
and research-plus-write. Reliability journeys also include explicit no-search,
saved-draft action,
clarification completion, fresh-news fail-closed, cancellation, and retry
recovery; those have outcome evidence but no separate writing class.

## Deterministic route gate

Run:

```bash
pnpm test:evals:cowork-v2-gate
```

This runs the authenticated chat-stream handler 300 times for each of twelve
critical journeys. Clarification completion and retry recovery each exercise
two turns, so the gate executes 4,200 authenticated route calls in total. The
test uses persistent in-memory Supabase behavior and
the real compiler, route, finalizer, writer/orchestrator adapters, action
checkpoints, canonical persistence, and SSE terminal contract. Model responses
are scripted, so its evidence source is `scripted` and `costObserved` is false.
The promotion gate must remain blocked after this test alone. The gate is
opt-in so its 4,200 route executions do not contend with unrelated tests during
the normal parallel suite.

## Live evidence file

Export safe run outcomes and blind scores as JSONL. Never include instructions,
prompt text, draft bodies, source text, model reasoning, credentials, or API
keys. The report importer rejects unsafe field names and unknown fields.

Run record:

```json
{"type":"run","data":{"runId":"opaque-run-001","architecture":"v2","journey":"original_post","variantId":"qwen-primary","modelComparisonGroup":"writer-direct-2026-07","evidenceSource":"live","productionShaped":true,"costObserved":true,"contractPassed":true,"terminalOutcome":"delivered","fallbackUsed":false,"latencyMs":8120,"inputTokens":1024,"outputTokens":341,"reasoningTokens":0,"cachedInputTokens":256,"chargedCostUsd":0.00184,"writerModel":"qwen/qwen3.7-plus"}}
```

Blind comparison record (score each dimension from 1 to 5):

```json
{"type":"blind_comparison","data":{"comparisonId":"opaque-review-001","comparisonKind":"architecture","writingClass":"original","blind":true,"candidates":[{"candidateId":"candidate-a","architecture":"baseline","writerModel":"z-ai/glm-5.2","scores":{"usefulness":4,"voice":4,"factuality":5,"completeness":4}},{"candidateId":"candidate-b","architecture":"v2","writerModel":"qwen/qwen3.7-plus","scores":{"usefulness":5,"voice":4,"factuality":5,"completeness":5}}],"preferredCandidateId":"candidate-b"}}
```

Browser status record:

```json
{"type":"browser_validation","data":{"desktop":"passed","mobile":"passed"}}
```

Generate the safe aggregate report:

```bash
pnpm cowork:v2:rollout-report artifacts/cowork-v2-evidence.jsonl artifacts/cowork-v2-rollout-report.json
```

The command exits `0` only when the promotion gate passes, `2` when evidence is
valid but promotion is blocked, and `1` for invalid or unsafe input.

## Blind review protocol

1. Use the same trusted instruction, voice context, source constraints, and
   output contract for both candidates.
2. Randomize which architecture appears as candidate A or B. Do not reveal the
   architecture or model until the score is locked.
3. Score usefulness, voice, factuality, and completeness independently from 1
   to 5, then record candidate A, candidate B, or tie as the preference.
4. Use at least 20 comparisons for every writing class. Do not reuse one score
   across classes.
5. Treat unsupported personal facts, stale news, incomplete posts, wrong
   counts, and source-provenance failures as factuality or completeness
   failures even when the prose sounds polished.

The report will not recommend Sonnet versus Gemini orchestration until each has
300 live, completed, provider-costed runs in the same comparison group, journey,
and writer-model stratum. Once a stratum qualifies, every live,
production-shaped attempt in it—including failures without provider cost—is
retained in the reliability ranking. It will not recommend Qwen versus GLM
writing until each has the equivalent matched evidence with the orchestrator
held constant and appears in 20 `writer_model` blind comparisons per writing
class.
Reliability and contract correctness sort first, blind writer quality next,
fallback/latency after that, and charged cost last.

## Rollout controls

Every lane supports its own flags and the shared `COWORK_V2_*` controls. Lane
prefixes are `COWORK_DIRECT_WRITER`, `COWORK_READ_ONLY_ORCHESTRATOR`, and
`COWORK_ACTION_ORCHESTRATOR`.

Shared controls:

- `COWORK_V2_ENABLED=1`
- `COWORK_V2_ROLLOUT_MODE=off|dark|sample|global`
- `COWORK_V2_ROLLOUT_PERCENT=0..100`
- `COWORK_V2_WORKSPACES=workspace-a,workspace-b`
- `COWORK_V2_DISABLED_WORKSPACES=workspace-x`
- `COWORK_V2_KILL_SWITCH=1`

Replace `COWORK_V2` with a lane prefix for a lane-specific override. A lane
kill switch or the shared kill switch always wins. Explicitly disabled
workspaces always stay on the hardened baseline. Percentage allocation uses a
stable workspace bucket, so a workspace does not bounce between cohorts.

When no rollout mode exists, the prior `*_ENABLED` plus `*_WORKSPACES`
allowlist behavior remains intact. Invalid percentages and modes fail closed.

`dark` evaluates the real v2 compiler and records the eligible candidate lane
in safe turn telemetry while continuing to serve the hardened baseline. It
does not make a second model call or execute a mutation. Full parallel shadow
execution is intentionally prohibited because it would duplicate paid
searches/writing and could repeat board side effects.

Recommended sequence:

1. `off` while gathering deterministic evidence.
2. `dark` to verify configuration and cohort selection without serving v2.
3. `sample` at 0% plus explicit internal workspaces.
4. `sample` at 1%, then 5%, then 25%, only while the live report remains green.
5. `global` only after the full promotion report passes.

## Alert and rollback behavior

Migration 096 installs a serialized, fleet-wide rolling 200-turn window. One
hard failure at a full window (0.5%) emits an operational alert. Two hard
failures (1%) latch the shared brake open. Every configured v2 request reads
that singleton before routing; a missing, malformed, or unavailable health row
fails closed to the hardened baseline. The per-instance monitor remains an
immediate second brake. Cancellation and typed recoverable errors do not count
as hard failures.

On alert, inspect safe telemetry and stop expansion. On rollback, the shared
brake moves every later request to the baseline automatically; also set
`COWORK_V2_KILL_SWITCH=1` before investigating. Reset is deliberately manual:
clear the event table and set the singleton to `insufficient`, zero counts, and
`rollback_open=false` only after the cause is fixed and the evidence gate is
rerun.

```sql
begin;
truncate table public.cowork_rollout_health_events restart identity;
update public.cowork_rollout_health
set sample_size = 0,
    hard_failures = 0,
    hard_failure_rate = 0,
    state = 'insufficient',
    rollback_open = false,
    updated_at = now()
where singleton;
commit;
```

Telemetry and evidence contain route, contract counts, stage codes, latency,
numeric token counts, charged cost, provenance state, and terminal outcome.
They never contain the user's instruction, draft text, source text, or hidden
reasoning.

## Authenticated browser validation

Desktop and mobile remain separate mandatory checks. For each critical journey:

1. Submit from a signed-in Cowork session.
2. Confirm honest activity state, one canonical deliverable, correct count,
   complete content, and a terminal response.
3. Reload and confirm the canonical draft or action persisted exactly once.
4. Exercise Stop during writing and during a complex route.
5. Verify Retry is offered for a typed recoverable failure and never duplicates
   a completed search, save, move, or schedule action.

Do not mark either browser status passed from API tests, screenshots, or a
logged-out page.
