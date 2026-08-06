-- Migration 177: daily swipe-file digests.
--
-- One stored brief per (workspace, day): what the day's tracked posts were
-- about, the strongest hook, the format that over-performed, and what to write
-- next. Produced by /api/cron/daily-digest, one LLM call per workspace.
--
-- Stored rather than generated on read for three reasons: it is a point-in-time
-- read of ONE day (regenerating it next week over the same posts would not
-- reproduce it, because the engagement numbers have moved), a stored row is
-- what makes the cost bounded and predictable, and the unique key below is what
-- stops a retried or double-fired cron from paying for the same day twice.
--
-- `input_tokens` / `output_tokens` / `cost_usd` are denormalized onto the row
-- on purpose. usage_events already records the spend, but answering "what did
-- digests cost us" from there means filtering by kind and hoping nothing else
-- shares it. Here it is one column on the thing that was produced.

begin;

create table if not exists public.daily_digests (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  -- The UTC day summarized, not the day the row was written. A recovery run
  -- the next morning still files under the day it analysed.
  digest_date date not null,
  content text not null,
  post_count integer not null default 0,
  model text,
  input_tokens integer,
  output_tokens integer,
  cost_usd numeric(12, 6),
  created_at timestamptz not null default now(),
  -- One digest per workspace per day. A retried cron upserts instead of
  -- inserting a second paid row.
  unique (workspace_id, digest_date)
);

-- The read pattern is "this workspace's recent digests, newest first".
create index if not exists daily_digests_workspace_date_idx
  on public.daily_digests (workspace_id, digest_date desc);

alter table public.daily_digests enable row level security;

-- Same per-workspace isolation as every other workspace-scoped table: a
-- workspace reads only its own digests. The cron writes with the service role,
-- which bypasses RLS.
drop policy if exists daily_digests_workspace_isolation on public.daily_digests;
create policy daily_digests_workspace_isolation on public.daily_digests
  for all
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());

grant all on table public.daily_digests to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 177, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
