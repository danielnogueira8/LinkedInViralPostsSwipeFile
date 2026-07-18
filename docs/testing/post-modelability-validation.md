# Modeled-source selection validation

Validated on 2026-07-18 against two read-only, bounded production samples:

- 500 non-empty posts ordered by reactions descending.
- 500 non-empty posts ordered by reactions ascending.

Only aggregate scorer outcomes were emitted; post bodies, workspace data, and
credentials were not logged. All 1,000 scorer executions completed without an
exception.

| Sample | Accepted | Caption reject | Other fatal rejects | Exceptions |
| --- | ---: | ---: | ---: | ---: |
| Highest reactions | 494 | 6 | 0 | 0 |
| Lowest reactions | 431 | 69 | 0 | 0 |

The distribution is a runtime-safety and calibration check, not a substitute
for labeled accuracy. Human-labeled boundary cases live permanently in
`evals/data/post-modelability.test.ts`; selection ordering, malformed data,
resource bounds, deterministic rotation, exact-count backfill, and client
relevance live in `evals/data/modeling-source-selection.test.ts`.

The selector accepts only a bounded, whitelisted relevance DTO created by
`lib/agent/modeling-selection-context.ts`; style rules, exemplars, mechanics,
backstory, and arbitrary nested voice fields cannot influence source ranking.
Creator niche is supplemental only and cannot substitute for topic evidence in
the post body. Durable rotation is claimed atomically in PostgreSQL and is
covered by a 24-connection concurrency regression.

Focused coverage for the scorer and selector is 100% for statements, functions,
and lines (92.8% aggregate branch coverage; the selection module is 89.9%
branch-covered).
