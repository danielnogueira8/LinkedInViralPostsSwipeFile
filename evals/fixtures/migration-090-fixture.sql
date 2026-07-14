\set ON_ERROR_STOP on

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;

create domain vector as text;

create table categories (
  id text primary key,
  label text not null
);
create table accounts (
  id uuid primary key,
  category_id text,
  linkedin_handle text,
  niche text,
  manual_owner_workspace_id text,
  recommendation_reason text,
  discovery_tags text[] not null default '{}',
  is_featured boolean not null default false,
  constraint accounts_category_id_fkey foreign key (category_id)
    references categories(id) on delete set null
);
create unique index accounts_linkedin_handle_ci_unique
  on accounts (lower(linkedin_handle));

create table workspace_accounts (
  workspace_id text not null,
  account_id uuid not null references accounts(id),
  primary key (workspace_id, account_id)
);
create table posts (
  id uuid primary key,
  account_id uuid not null references accounts(id)
);
create table hooks (
  id uuid primary key,
  post_id uuid not null references posts(id)
);
create table runs (
  id uuid primary key,
  workspace_id text
);
create table backfill_runs (
  id uuid primary key
);
create table shared_bookmarks (
  id uuid primary key,
  owner_workspace_id text not null,
  recipient_user_id text,
  status text not null
);
create table saved_posts (
  id uuid primary key,
  workspace_id text not null
);
create table saved_post_overrides (
  id uuid primary key,
  saved_post_id uuid not null references saved_posts(id),
  recipient_user_id text not null,
  unique (saved_post_id, recipient_user_id)
);
create table post_embeddings (
  post_id uuid primary key references posts(id),
  embedding vector not null,
  model text not null,
  content_hash text not null,
  embedded_at timestamptz not null default now()
);
create index post_embeddings_cosine_idx on post_embeddings (embedding);
create index post_embeddings_model_idx on post_embeddings (model);

create table batch_runs (id uuid primary key, workspace_id text, status text);
create unique index batch_runs_one_active_per_workspace
  on batch_runs (workspace_id) where status in ('pending', 'running');

create table app_schema_version (
  singleton boolean primary key default true check (singleton),
  version integer not null,
  updated_at timestamptz not null default now()
);
insert into app_schema_version (singleton, version) values (true, 89);
alter table app_schema_version enable row level security;

create table clients (id integer);
create table image_prompts (id integer);
create table settings (id integer);
create table templates (id integer);
create table chats (id integer, turn_cost_operation_key text);
create table chat_messages (id integer, artifacts_version integer);
create table chat_artifacts (id integer, lifecycle_version integer);
create table chat_modeling_sources (id integer, post_type text);
create table custom_skills (id integer);
create table voice_profiles (id integer);
create table usage_events (id integer);
create table content_feedback (id integer);
create table content_preferences (id integer);
create table content_templates (id integer);
create table creator_style_profiles (id integer);
create table creator_style_profile_sources (id integer);
create table lead_magnets (id integer);
create table lead_magnet_generation_claims (id integer, workspace_id text);
create table media_assets (id integer);
create table media_quota_claims (id integer, workspace_id text);
create table publishing_connections (
  id integer,
  profile_claim_token uuid,
  profile_claimed_at timestamptz
);
create table batch_draft_slots (id integer);
create table background_jobs (id integer);
create table provider_locks (id integer);
create table workspace_cost_claims (id integer, workspace_id text);
create table ai_operation_claims (id integer, workspace_id text);
create table workspace_post_classification (id integer, workspace_id text);
create table post_analytics (id integer, workspace_id text);
create table analytics_refresh_state (id integer);
create table freshness_constraint_cache (id integer, workspace_id text);
create table image_analysis_cache (id integer);

create or replace function auth_workspace_id() returns text
language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'org_id', '')
$$;

create function claim_background_job(text, integer) returns integer language sql as $$select 1$$;
create function acquire_provider_lock(text, text, uuid, text, integer, integer) returns integer language sql as $$select 1$$;
create function release_provider_lock(uuid) returns integer language sql as $$select 1$$;
create function claim_scrape_run(text, timestamptz) returns integer language sql as $$select 1$$;
create function claim_lead_magnet_generation(text, text, integer) returns integer language sql as $$select 1$$;
create function claim_media_quota(text, bigint, bigint) returns integer language sql as $$select 1$$;
create function claim_publishing_profile(text) returns integer language sql as $$select 1$$;
create function claim_analytics_refresh(integer) returns integer language sql as $$select 1$$;
create function claim_ai_operation(text, text, integer) returns integer language sql as $$select 1$$;
create function release_ai_operation(text, uuid) returns integer language sql as $$select 1$$;
create function claim_daily_scrape_recovery(timestamptz, timestamptz) returns integer language sql as $$select 1$$;
create function claim_workspace_cost(text, text, numeric, numeric, integer) returns integer language sql as $$select 1$$;
create function release_workspace_cost(text, text) returns integer language sql as $$select 1$$;
create function hold_workspace_cost_claims(text) returns integer language sql as $$select 1$$;
create function claim_chat_turn(text, uuid, text, integer, integer, integer, integer, numeric, numeric) returns integer language sql as $$select 1$$;
create function release_chat_turn_workspace_cost(text, uuid, text) returns integer language sql as $$select 1$$;
create function save_chat_draft(text, uuid, text, text, text, text, jsonb, jsonb, text) returns integer language sql as $$select 1$$;
create function persist_chat_assistant_turn(uuid, text, text, jsonb, jsonb, integer, integer, jsonb) returns integer language sql as $$select 1$$;
create function match_post_embeddings(vector, boolean, text, uuid[], integer) returns integer language sql as $$select 1$$;

create function protect_account_niche() returns trigger language plpgsql as $$
begin return new; end
$$;
create trigger protect_account_niche_trg before update on accounts
for each row execute function protect_account_niche();

create function enforce_workspace_manual_account_limit() returns trigger language plpgsql as $$
begin return new; end
$$;
create trigger workspace_accounts_manual_limit before insert on workspace_accounts
for each row execute function enforce_workspace_manual_account_limit();

alter table post_embeddings enable row level security;
create policy post_embeddings_read_via_post on post_embeddings
for select using (
  exists (
    select 1
    from posts p
    join workspace_accounts wa on wa.account_id = p.account_id
    where p.id = post_embeddings.post_id
      and wa.workspace_id = auth_workspace_id()
  )
);

alter table hooks enable row level security;
alter table runs enable row level security;
alter table shared_bookmarks enable row level security;
alter table saved_posts enable row level security;
alter table saved_post_overrides enable row level security;

create policy legacy_public_hooks on hooks for select using (true);
create policy legacy_public_runs on runs for select using (true);
create policy legacy_public_shares on shared_bookmarks for select using (true);
create policy legacy_public_saves on saved_posts for select using (true);
create policy legacy_public_overrides on saved_post_overrides for select using (true);

grant select on posts, workspace_accounts to anon, authenticated;
grant select, insert, update, delete on hooks, runs, backfill_runs,
  shared_bookmarks, saved_posts, saved_post_overrides to anon, authenticated;
grant all privileges on all tables in schema public to service_role;
grant execute on all functions in schema public to anon, authenticated, service_role;

insert into categories (id, label) values ('gtm', 'Marketing & Growth');
insert into accounts (id, category_id, linkedin_handle) values
  ('00000000-0000-0000-0000-000000000001', 'gtm', 'creator-one'),
  ('00000000-0000-0000-0000-000000000002', 'gtm', 'creator-two');
insert into workspace_accounts (workspace_id, account_id) values
  ('ws-owner', '00000000-0000-0000-0000-000000000001'),
  ('ws-other', '00000000-0000-0000-0000-000000000002');
insert into posts (id, account_id) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002');
insert into hooks (id, post_id) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002');
insert into runs (id, workspace_id) values
  ('30000000-0000-0000-0000-000000000001', null),
  ('30000000-0000-0000-0000-000000000002', 'ws-owner'),
  ('30000000-0000-0000-0000-000000000003', 'ws-other');
insert into backfill_runs (id) values ('40000000-0000-0000-0000-000000000001');
insert into shared_bookmarks (id, owner_workspace_id, recipient_user_id, status) values
  ('50000000-0000-0000-0000-000000000001', 'ws-owner', 'user-recipient', 'accepted'),
  ('50000000-0000-0000-0000-000000000002', 'ws-other', 'user-other', 'accepted');
insert into saved_posts (id, workspace_id) values
  ('60000000-0000-0000-0000-000000000001', 'ws-owner'),
  ('60000000-0000-0000-0000-000000000002', 'ws-other');
insert into saved_post_overrides (id, saved_post_id, recipient_user_id) values
  ('70000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001', 'user-recipient'),
  ('70000000-0000-0000-0000-000000000002', '60000000-0000-0000-0000-000000000002', 'user-other');
