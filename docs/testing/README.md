# Quality coverage map

The release-readiness source of truth is `critical-journeys.json`. It maps each
critical product capability to one user-visible invariant, the highest useful
test seam, current evidence, gap status, and the GitHub issue that closes the
remaining gap.

`api-contracts.json` is the API-family index. It links every critical route
family to deterministic success, failure, workspace-isolation, and destructive
or retryable mutation evidence. Add a family or update its evidence whenever a
new sensitive API surface is introduced.

Raw coverage is supporting evidence, not the target. A module can have high line
coverage while a navigation, ownership, concurrency, or persistence invariant
remains untested. Conversely, framework glue can lower global statement coverage
without representing meaningful product risk.

## Baseline

Measured on 2026-07-12 with the deterministic Vitest suite:

- Test files: 180 passed
- Tests: 2,119 passed
- Statements: 32.25%
- Branches: 77.47%
- Functions: 59.22%
- Lines: 32.25%

No global threshold is enforced at this stage. Focused thresholds can be added
to critical modules only after the linked gap-closing tickets land.

## Commands

```bash
npm run test:evals       # fast deterministic regression suite
npm run test:coverage    # deterministic suite plus concise coverage summary
npm run e2e:mcp-app      # self-contained MCP App browser checks
npm run e2e:smoke        # authenticated render smoke checks
npm run e2e:ui           # critical UI workflow checks
```

## Cowork persisted-outcome harness

`evals/data/cowork-outcome-harness.test.ts` drives a signed-in request through
the real chat stream route and `ChatTurn` module, then judges the canonical
persisted messages and artifacts plus all dispatched tool actions, terminal
state, tokens, latency, and cost. Clerk, Supabase, and the OpenRouter transport
are deterministic adapters; the agent loop, tool dispatch, HTTP parsing, setup,
SSE transport, lifecycle ordering, usage pricing, and atomic assistant
persistence are the production implementations. OpenRouter usage rows are also
written through the production logger into the stateful database adapter, so
workspace, stage, token, and cost persistence are asserted rather than mocked.

The fixed matrix includes original posts, one-draft refinement, verified-source
modeling, clarification completion, explicit no-search, partial hooks, multiple
drafts, read-only analysis, planning, grounded-news fail-closed behavior, a real
draft-board mutation, cancellation, provider timeout, and same-chat retry
recovery. Negative controls prove the harness turns red for the exact 2026-07-14
truncated post, empty turns, wrong deliverable counts, unsupported provenance,
and duplicate artifacts or semantically duplicate actions.

Only `safeCoworkReportLine` is suitable for CI output. It serializes a strict
whitelist of scenario id, status, terminal state, counts, tokens, latency, and
cost. It cannot include prompts, draft bodies, credentials, model errors, or
chain-of-thought. The richer persisted outcome exists only for in-process test
assertions and must never be logged.

The `evals` GitHub Actions workflow runs `test:coverage` on pull requests and
`main`, then uploads `coverage/coverage-summary.json` as the
`deterministic-coverage-summary` artifact for 30 days.

`cowork-state-invariants.json` maps per-chat ownership, hydration, stream,
recovery, artifact, and navigation state machines to deterministic and browser
evidence. Composer accessories must be owned by a chat (including the unsaved
new-session slot), never by the globally mounted workspace.

`operational-invariants.json` is the fail-closed map for quotas, atomic claims,
worker/provider leases, batch concurrency, recovery, and cron alerting. Each row
links a production boundary to deterministic evidence; the inventory test fails
when a required boundary or evidence file disappears.

Swipe File and Bookmarks are covered as one continuous workflow. The critical
journey evidence verifies query and workspace scope, persisted filters, regular
and lead-magnet metadata, save/remove behavior, shared-library boundaries,
media dialogs, and Model with Cowork handoffs. Every representative browser
journey fails on unexpected console errors or page exceptions.

The complete post lifecycle is split at the irreversible boundary. Deterministic
API-contract tests prove draft metadata/media preservation and publishing worker
idempotency (duplicate claims, transient retries, expired tokens, lost or stale
claims, and terminal outcomes). Markdown-emitting drafts additionally prove one
canonical raw → preview → copy → length-check → publish conversion, with durable
format provenance across batch, chat, board, and model-switch history. `e2e/draft-lifecycle.spec.ts` follows a real
Cowork save into the Posts board and through review and scheduling controls while
explicitly failing if any browser request reaches a publish or Zernio endpoint.

Update the matrix whenever a critical workflow changes, a production bug adds a
new invariant, or a gap-closing ticket lands. `quality-inventory.test.ts` checks
that every required capability stays represented and that all evidence paths
remain valid.

## Layered release commands

- Local: `npm run test:evals` while editing; `npm run test:coverage` before push.
- Pull requests: deterministic invariants and focused critical-module coverage
  block merge. Authenticated critical journeys run when E2E secrets are present;
  one diagnostic retry is allowed, but a failed-then-passed test still fails the
  zero-flake policy. Traces, screenshots, JSON, and HTML reports upload on failure.
- Nightly: browser journeys run on pushes to `main`.
- Pre-release: run `npm run test:coverage` and `npm run e2e:critical:ci`.

Focused thresholds live in `docs/testing/focused-coverage.json`. They protect a
small set of concurrency/ownership modules; no arbitrary global percentage is
used. Raise a module threshold only with a focused test that protects a named
invariant.
