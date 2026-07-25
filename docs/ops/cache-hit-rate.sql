-- Prompt-cache hit rate, by call kind.
--
-- Run this BEFORE and AFTER any caching change. Without a baseline you cannot
-- tell a change that landed from one that silently did nothing — the failure
-- mode of prompt caching is not an error, it's a zero.
--
-- The three token buckets are disjoint, and the total prompt size is their sum:
--   input_tokens        — processed at full price (not cached)
--   cached_input_tokens — served from cache  (~0.1x input price)
--   cache_write_tokens  — written to cache   (~1.25x input price, 5-min TTL)
--
-- Reading `input_tokens` alone is misleading: a well-cached agent shows a small
-- number there because most of the prompt came from cache.

-- 1) Hit rate + spend by kind, last 7 days.
select
  kind,
  count(*)                                          as calls,
  sum((meta->>'cached_input_tokens')::bigint)       as cached_read,
  sum((meta->>'cache_write_tokens')::bigint)        as cache_write,
  sum(input_tokens)                                 as uncached_input,
  -- Share of all prompt tokens that were served from cache.
  round(
    100.0 * sum((meta->>'cached_input_tokens')::bigint)
    / nullif(
        sum(input_tokens)
        + sum((meta->>'cached_input_tokens')::bigint)
        + sum((meta->>'cache_write_tokens')::bigint),
        0),
    1)                                              as hit_rate_pct,
  round(sum(cost_usd)::numeric, 4)                  as cost_usd
from usage_events
where ts >= now() - interval '7 days'
group by kind
order by cost_usd desc nulls last;

-- 2) The fragmentation signal.
--
-- A prefix that is written far more often than it is read is being FRAGMENTED:
-- something volatile sits ahead of the cached block, so each call writes its own
-- entry and none are ever reused. Expect this to be bad for the writer today —
-- its per-variation line precedes ~5-8k tokens of static skill text — and to
-- improve if that line moves after the skills.
--
-- Rule of thumb: writes should be a small fraction of reads on a hot path.
select
  kind,
  sum((meta->>'cache_write_tokens')::bigint)  as cache_write,
  sum((meta->>'cached_input_tokens')::bigint) as cached_read,
  round(
    sum((meta->>'cache_write_tokens')::bigint)::numeric
    / nullif(sum((meta->>'cached_input_tokens')::bigint), 0),
    2)                                        as write_to_read_ratio
from usage_events
where ts >= now() - interval '7 days'
group by kind
having sum((meta->>'cache_write_tokens')::bigint) > 0
order by write_to_read_ratio desc nulls last;

-- 3) Sanity check: is anything caching at all?
-- All-zero cached_read across a busy kind means either the prompt is below the
-- model's minimum cacheable prefix, or a silent invalidator sits in the prefix.
select
  date_trunc('day', ts) as day,
  sum((meta->>'cached_input_tokens')::bigint) as cached_read,
  sum((meta->>'cache_write_tokens')::bigint)  as cache_write
from usage_events
where ts >= now() - interval '14 days'
group by 1
order by 1 desc;
