-- Track per-call API usage so we can show cost breakdowns
create table if not exists usage_events (
  id uuid primary key default gen_random_uuid(),
  ts timestamptz not null default now(),
  provider text not null check (provider in ('anthropic', 'apify')),
  kind text not null,
  model text,
  input_tokens int,
  output_tokens int,
  units numeric,
  cost_usd numeric not null default 0,
  run_id uuid references runs(id) on delete set null,
  meta jsonb
);

create index if not exists usage_events_ts_idx on usage_events(ts desc);
create index if not exists usage_events_provider_idx on usage_events(provider);
