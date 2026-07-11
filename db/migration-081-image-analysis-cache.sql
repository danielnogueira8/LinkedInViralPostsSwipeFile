-- Exact-input cache for paid image-description and layout-analysis calls.
-- Entries are workspace scoped; model and prompt-version changes invalidate
-- naturally without deleting older rows.
create table if not exists image_analysis_cache (
  workspace_id text not null,
  analysis_kind text not null,
  input_hash text not null,
  model text not null,
  prompt_version integer not null,
  result_text text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, analysis_kind, input_hash)
);

alter table image_analysis_cache enable row level security;

revoke all on image_analysis_cache from public, anon, authenticated;
grant select, insert, update, delete on image_analysis_cache to service_role;
