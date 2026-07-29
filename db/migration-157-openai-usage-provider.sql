begin;

alter table public.usage_events
  drop constraint if exists usage_events_provider_check;

alter table public.usage_events
  add constraint usage_events_provider_check
  check (provider in ('anthropic', 'apify', 'openai', 'openrouter', 'zernio'));

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 157, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
