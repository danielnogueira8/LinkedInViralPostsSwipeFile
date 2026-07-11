-- One exact-input freshness result per workspace. The application includes the
-- model and prompt version in the match, and replaces this row whenever the
-- recent-draft history hash changes.

create table if not exists freshness_constraint_cache (
  workspace_id text primary key,
  history_hash text not null,
  model text not null,
  prompt_version integer not null,
  markers jsonb not null default '[]'::jsonb
    check (jsonb_typeof(markers) = 'array'),
  updated_at timestamptz not null default now()
);

alter table freshness_constraint_cache enable row level security;

drop policy if exists freshness_constraint_cache_isolation
  on freshness_constraint_cache;
create policy freshness_constraint_cache_isolation
  on freshness_constraint_cache
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());

revoke all on freshness_constraint_cache from public, anon, authenticated;
grant select, insert, update, delete on freshness_constraint_cache to service_role;
