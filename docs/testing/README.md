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
npm run e2e:smoke        # authenticated render smoke checks
npm run e2e:ui           # critical UI workflow checks
npm run test:evals:live  # opt-in paid live-model contracts
```

The `evals` GitHub Actions workflow runs `test:coverage` on pull requests and
`main`, then uploads `coverage/coverage-summary.json` as the
`deterministic-coverage-summary` artifact for 30 days.

`cowork-state-invariants.json` maps per-chat ownership, hydration, stream,
recovery, artifact, and navigation state machines to deterministic and browser
evidence. Composer accessories must be owned by a chat (including the unsaved
new-session slot), never by the globally mounted workspace.

Swipe File and Bookmarks are covered as one continuous workflow. The critical
journey evidence verifies query and workspace scope, persisted filters, regular
and lead-magnet metadata, save/remove behavior, shared-library boundaries,
media dialogs, and Model with Cowork handoffs. Every representative browser
journey fails on unexpected console errors or page exceptions.

Update the matrix whenever a critical workflow changes, a production bug adds a
new invariant, or a gap-closing ticket lands. `quality-inventory.test.ts` checks
that every required capability stays represented and that all evidence paths
remain valid.
