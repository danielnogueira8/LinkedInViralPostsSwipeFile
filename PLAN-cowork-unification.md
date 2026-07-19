# Cowork Unification Plan

**Branch:** `cowork/unification` (off `codex/defensive-draft-generation`)
**Date:** 2026-07-19
**Status:** Approved by owner — executing

## Problem

Cowork runs four architectures at once (legacy agent loop, direct writer, read-only
orchestrator, action orchestrator) with per-turn, non-sticky routing between them.
The chronic production symptoms — drafts not generated, context losses, draft counts
not respected — live in the seams between those paths:

- **No drafts:** 15-gate finalizer attrition (`lib/agent/draft-finalizer.ts:363-756`),
  impossible deadline math (60s engine deadline vs 3×45s writer calls + finalizer
  model calls), swallowed writer exceptions (`draft-engine.ts:1696-1702`,
  `1796-1802`, `1848-1854`), orchestrator buffering-and-dropping produced drafts
  (`read-only-orchestrator.ts:3044-3048`), fake `terminalReason:"done"` on failure
  (`draft-engine.ts:1536-1540`).
- **Context loss:** direct writer receives zero conversation history
  (`draft-engine.ts:172-227`); UI draft-count override forces that path
  (`chat-turn.ts:3691-3701`); attachments consumed once, never persisted
  (`chat-turn.ts:2187-2190`); four different history windows across stages.
- **Count drift:** six disagreeing ceilings (10/10/20/5/2-6/2-5), silent
  default-to-1 (`read-only-orchestrator-routing.ts:712`), contract computed twice
  per turn with different instruction strings (`chat-turn.ts:2499-2560` vs
  `4138-4150`), opposite partial-set semantics per path.

## Approved decisions (owner, 2026-07-19)

1. **Deterministic-first, model-second.** One compiler produces a `TurnPlan`;
   a thin LLM Agent executor exists only as fallback when the compiler cannot
   produce a confident plan. The Agent never writes prose — it delegates to the
   Writer.
2. **One count rule:** 1–6 drafts per turn, everywhere, enforced structurally
   (N count = N slot calls). Partial sets are always presented with an honest
   message.
3. **Hard cut.** The legacy path is deleted outright in this restructure (git
   history is the kill switch), along with the rollout flag matrix, shadow/dark
   launch routing, and evidence gates.

## Target architecture

```
user message
  ├─ 1. SETUP      claim turn, rate limits, persist user row, duplicate guard
  ├─ 2. CONTEXT    ONE builder → TurnContext (history + voice + prefs + sources + attachments)
  ├─ 3. COMPILE    ONE parser → immutable TurnPlan { intent, count, contract, sourcePolicy, needsResearch, actions[] }
  ├─ 4. EXECUTE    Writer (tool-free, slots) | Agent (tool loop, delegates prose to Writer)
  ├─ 5. FINALIZE   ONE finalizer, ~5 checks, structural count enforcement
  └─ 6. OUTCOME    ONE terminal vocabulary → persist + stream
                   delivered | clarified | cancelled | recoverable_error | hard_failure
```

Target file layout (`lib/agent/` ~60 files → ~20):

```
turn/     setup.ts · context.ts · compile.ts · outcome.ts · stream.ts
execute/  writer.ts · agent.ts · checkpoints.ts (kept — genuinely good)
finalize/ finalizer.ts  (5 checks: non-empty/corrupt → contract(count+chars) →
                         provenance → one quality specialist → artifact build)
```

Routing rule for future edits: how turns are understood → `compile.ts`; how turns
see the world → `context.ts`; whether output is acceptable → `finalizer.ts`.

## Phases

### Phase 0 — Honest failures (stop prod from lying) — THIS BRANCH FIRST

Small, independently testable fixes on current code:

- [x] **0.1 Voice-fail 503→422.** Distinguish "no voice profile" (permanent → 422,
      non-recoverable, Voice-tab guidance, no `_recoverable` marker) from transient
      voice-load errors (stay recoverable 503). Implements the spec already written
      in the uncommitted `evals/data/cowork-outcome-harness.test.ts` diff; the
      `noReadyVoiceProfile` branch it references does not exist yet
      (`chat-turn.ts:4026-4058` currently collapses all failures into recoverable 503).
- [x] **0.2 Log swallowed writer exceptions.** `draft-engine.ts:1696-1702`,
      `1796-1802`, `1848-1854` — typed reason + console.error with stage, task kind,
      error class. No silent degradation.
- [x] **0.3 Stop orchestrator dropping produced drafts.**
      `read-only-orchestrator.ts:2885-2895`, `3011-3048` — present accepted partial
      sets with honest message instead of nuking them; align with direct-multi
      behavior (`draft-engine.ts:1138-1173`).
- [x] **0.4 Batch "preserved drafts" must actually present.**
      `read-only-orchestrator.ts:2779-2844` — message claims preserved drafts,
      shows none.
- [x] **0.5 Honest terminal reasons.** Exhaust path must not yield
      `terminalReason:"done"` (`draft-engine.ts:1536-1540`, `1891`); typed
      `failure` reason; fix slot-runner special-case accordingly
      (`modeled-draft-slot-runner.ts:309-336`).

Each fix: targeted vitest runs + `tsc --noEmit` + lint, separate commit.

### Phase 1 — Unified skeleton, delete legacy

- Build `turn/context.ts` (one context builder; writer ALWAYS gets history;
  attachment text persisted as first-class message content), `turn/compile.ts`
  (one intent/count parser: UI override > message text > default 1; cap 1–6;
  computed once, post-clarification), `turn/outcome.ts` (one terminal vocabulary).
- Route 100% of turns through the skeleton around existing v2 executors.
- Delete: legacy loop (`run.ts` 227KB), `decide.ts`, three `*-routing.ts` files,
  rollout flags/shadow routing/evidence gates, synthetic `tool_calls` markers
  (→ real columns), duplicate partial gauntlet.
- Session-sticky routing per chat.

### Phase 2 — Merge executors, collapse finalizer

- `execute/writer.ts` absorbs draft-engine + modeled-batch + slot-runner
  (slots = the only multi-draft mechanism).
- `execute/agent.ts` absorbs both orchestrators; never writes prose.
- `finalize/finalizer.ts`: 15 gates → 5; kill double policy eval, triple
  char-cap, lean/heavy profile split.
- Fix deadline math: worst-case chain must fit the budget.

### Phase 3 — State as data, decomposition

- Turn state in columns/RPC, not transcript JSONB markers (7 marker types,
  3 parsers today).
- Break `executeChatTurn` (~3,200 lines) into the five stage modules.
- Trim eval harness to the seams (context, compile, finalizer deterministic;
  writer/agent behind scripted adapters).

## Testing strategy (per PR/commit)

1. Targeted vitest files for the touched area (must stay green).
2. `npx tsc --noEmit` clean.
3. `npm run lint` on touched files.
4. Full `npm run test:evals` before pushing each phase branch.
5. Live model verification (`test:evals:live`) requires provider keys — flag to
   owner when reached.

## Time estimate (agent working time)

| Phase | Estimate | Notes |
|---|---|---|
| Plan doc | ~15 min | this file |
| Phase 0 | 2–4 h | 5 surgical fixes + tests + commits |
| Phase 1 | 1–2 sessions | largest deletion; new skeleton modules |
| Phase 2 | 1–2 sessions | executor merge + finalizer collapse |
| Phase 3 | 1 session | decomposition + harness trim |

Estimates assume deterministic tests stay green; live-model verification adds
wall-clock time and needs keys.

## Risks / watch-items

- `chat-turn.ts` (5,245 lines) is the single most dangerous file; all Phase 1
  changes land there — keep diffs small and tested.
- The uncommitted harness-test diff is the spec for 0.1; keep it, make it pass.
- Do not touch `.env*` files. Vercel token used read-only for logs; never commit it.
- e2e/playwright requires a running app; run targeted specs only when a change
  touches the stream route contract.
