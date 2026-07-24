# Test coverage hardening — session report

Targeted hardening of the code shipped this session (the "confirm before
generating" read-back + the swipe-file routing fixes), driven by an actual
coverage measurement rather than guesswork. The repo already has strong
testing discipline (4300+ tests, a per-module coverage gate), so this was a
surgical fill-the-gaps pass on the newest, highest-risk modules.

## Baseline (before)

| Module | Stmts | Branch | Funcs |
|---|---|---|---|
| `lib/agent/turn/resolve-decision.ts` | 84.79% | 89.13% | 66.66% |
| `app/api/chats/[id]/resolve/route.ts` | 81.39% | 73.33% | 66.66% |
| `app/(app)/dashboard/confirm-readback.tsx` | 40.42% | 81.25% | 75% |
| `lib/agent/turn/compile.ts` | 90.9% | 85.8% | 100% |
| `lib/agent/turn/preclaim-routing.ts` | 100% | 100% | 100% |

The 66% functions on `resolve-decision.ts` was the standout: the production
`listWorkspaceNiches` fetch was never exercised (tests inject a fake `deps`).
The 40% on the UI component: only the pure `summarize`/`chips` helpers were
tested — the component itself was never rendered.

## After

| Module | Stmts | Branch | Funcs | What was added |
|---|---|---|---|---|
| `resolve-decision.ts` | **100%** | **92.06%** | **83.33%** | production `listWorkspaceNiches` (happy path, `ok:false`, non-array, null, throw→`[]` fail-open) in a new mocked test file; the `operation`-not-`command` path; every conflict `fix` value; `postCount`/`taskKind`/`route` fields; the no-conflict-when-lead-magnet-actually-applies case |
| `resolve/route.ts` | all 4 error paths now covered | — | — | auth throw, workspace-resolve throw, resolver throw, non-JSON body — each returns via `errorResponse` instead of crashing |
| `confirm-readback.tsx` | **92.19%** | 86.48% | 92.19% | a `renderToStaticMarkup` render test asserting the summary, every chip (Mode / Niche / Count / Source), the amber conflict row + Fix control, and the action buttons |
| `compile.ts` (swipe-file) | unchanged % but hardened | — | — | the swipe-file guarantee is now also locked through the **`cowork-outcome-harness`** (the real pipeline, `report.safe.route`), incl. a free-text-no-command swipe-file search |

## New coverage gates

Added to `docs/testing/focused-coverage.json` so CI blocks any regression that
lowers them:

- `lib/agent/turn/preclaim-routing.ts` → 100 / 100 / 100 / 100
- `lib/agent/turn/resolve-decision.ts` → 98 / 88 / 80 / 98

## Test count

~30 new tests across 6 files. Full suite: **4364 passing** (was 4339), same 8
pre-existing `CREDENTIAL_ENCRYPTION_KEY`-unset suites that only fail on a local
runner without the env var (they pass in CI).

## The key lesson — and the real recommendation

Twice this session a fix **passed its isolated unit tests but failed the real
pipeline**: the swipe-file "I don't have access" bug (#1455 → #1456) and,
earlier, the niche "Give me" bug. The root cause both times: `compileReadOnly-
OrchestratorRoute` is **not always called** — `compileTurnPlan` wraps it and can
divert to a tool-less answer lane *before* the sub-router runs. An isolated
`compileReadOnlyOrchestratorRoute(instruction)` test was green while the real
turn (with `command:{kind:"ask"}`) was broken.

**Coverage % does not catch this class of bug.** Those lines were "covered" —
by the isolated tests. Line coverage measures *execution*, not *whether an
assertion would fail if the logic were wrong*. So the genuine next steps are:

1. **Mutation testing (Stryker) on the routing/resolver core.** Stryker mutates
   the guards (flip a `&&`, drop a condition, negate a return) and re-runs the
   tests; if they still pass, the test is asserting nothing meaningful. It would
   have flagged the "passes isolated, fails pipeline" gap directly — the
   strongest signal available and the right TS equivalent of the risk metric
   `crap4java` computes (crap4java is Java and won't run on this repo;
   coverage×complexity is the CRAP idea, but Stryker's *mutation score* is a
   sharper measure of test quality).
2. **Route every new routing test through `cowork-outcome-harness`** (which
   asserts `report.safe.route` end-to-end), not just the sub-router. This is now
   a written invariant in memory.
3. **A small gherkin / cucumber-js layer** for the load-bearing product
   invariants ("an explicit swipe-file search ALWAYS searches, never answers
   conversationally") as an executable, human-readable spec — cheap, and it
   pins the behavior the business actually cares about.

Recommendation: pilot **Stryker on `lib/agent/turn/`** (compile / preclaim /
resolve-decision) as one focused PR before committing to a whole mutation-
testing program — it's the highest-value single move given this session's bug
pattern, and it'll show concretely which existing tests are weaker than their
coverage % implies.
