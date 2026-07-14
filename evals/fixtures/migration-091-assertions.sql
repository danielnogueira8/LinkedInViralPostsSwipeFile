\set ON_ERROR_STOP on

create function assert_count(label text, actual bigint, expected bigint)
returns text language plpgsql as $$
begin
  if actual <> expected then
    raise exception '%: expected %, got %', label, expected, actual;
  end if;
  return label || ':ok';
end
$$;
grant execute on function assert_count(text, bigint, bigint) to anon, authenticated, service_role;

create function attempt_delete(relation_name text)
returns bigint language plpgsql as $$
declare
  affected bigint;
begin
  execute format('delete from %I', relation_name);
  get diagnostics affected = row_count;
  return affected;
end
$$;
grant execute on function attempt_delete(text) to authenticated;

create function attempt_override_update(override_id uuid)
returns bigint language plpgsql as $$
declare affected bigint;
begin
  update saved_post_overrides spo
  set recipient_user_id = spo.recipient_user_id
  where spo.id = override_id;
  get diagnostics affected = row_count;
  return affected;
end
$$;

create function attempt_override_delete(override_id uuid)
returns bigint language plpgsql as $$
declare affected bigint;
begin
  delete from saved_post_overrides spo where spo.id = override_id;
  get diagnostics affected = row_count;
  return affected;
end
$$;

create function attempt_override_insert(
  override_id uuid,
  target_saved_post_id uuid,
  target_user_id text
)
returns bigint language plpgsql as $$
declare affected bigint;
begin
  insert into saved_post_overrides (id, saved_post_id, recipient_user_id)
  values (override_id, target_saved_post_id, target_user_id);
  get diagnostics affected = row_count;
  return affected;
exception when insufficient_privilege then
  return 0;
end
$$;

grant execute on function attempt_override_update(uuid) to authenticated;
grant execute on function attempt_override_delete(uuid) to authenticated;
grant execute on function attempt_override_insert(uuid, uuid, text) to authenticated;

set role anon;
set request.jwt.claims = '{}';
select assert_count('anon hooks', (select count(*) from hooks), 0);
select assert_count('anon runs', (select count(*) from runs), 0);
select assert_count('anon shares', (select count(*) from shared_bookmarks), 0);
select assert_count('anon saves', (select count(*) from saved_posts), 0);
select assert_count('anon overrides', (select count(*) from saved_post_overrides), 0);
reset role;

select assert_count(
  'anon backfill privileges',
  has_table_privilege('anon', 'public.backfill_runs', 'select')::integer,
  0
);

set role authenticated;
set request.jwt.claims = '{"org_id":"ws-owner","sub":"user-owner"}';
select assert_count('owner hooks', (select count(*) from hooks), 1);
select assert_count('owner runs', (select count(*) from runs), 2);
select assert_count('owner shares', (select count(*) from shared_bookmarks), 1);
select assert_count('owner saves', (select count(*) from saved_posts), 1);
select assert_count('owner overrides', (select count(*) from saved_post_overrides), 0);

set request.jwt.claims = '{"org_id":"ws-recipient","sub":"user-recipient"}';
select assert_count('recipient hooks', (select count(*) from hooks), 0);
select assert_count('recipient runs', (select count(*) from runs), 1);
select assert_count('recipient shares', (select count(*) from shared_bookmarks), 1);
select assert_count('recipient saves', (select count(*) from saved_posts), 1);
select assert_count('recipient overrides', (select count(*) from saved_post_overrides), 1);
begin;
select assert_count(
  'recipient updates own override',
  attempt_override_update('70000000-0000-0000-0000-000000000001'),
  1
);
select assert_count(
  'recipient deletes own override',
  attempt_override_delete('70000000-0000-0000-0000-000000000001'),
  1
);
select assert_count(
  'recipient inserts own override',
  attempt_override_insert(
    '70000000-0000-0000-0000-000000000003',
    '60000000-0000-0000-0000-000000000001',
    'user-recipient'
  ),
  1
);
rollback;
select assert_count(
  'recipient cannot delete owner shares',
  attempt_delete('shared_bookmarks'),
  0
);
select assert_count(
  'recipient cannot delete owner saves',
  attempt_delete('saved_posts'),
  0
);
select assert_count(
  'recipient cannot delete global runs',
  attempt_delete('runs'),
  0
);

set request.jwt.claims = '{"org_id":"ws-recipient","sub":"user-wrong"}';
select assert_count('same-org wrong-user shares', (select count(*) from shared_bookmarks), 0);
select assert_count('same-org wrong-user saves', (select count(*) from saved_posts), 0);
select assert_count('same-org wrong-user overrides', (select count(*) from saved_post_overrides), 0);
select assert_count(
  'same-org wrong-user cannot update override',
  attempt_override_update('70000000-0000-0000-0000-000000000001'),
  0
);
select assert_count(
  'same-org wrong-user cannot delete override',
  attempt_override_delete('70000000-0000-0000-0000-000000000001'),
  0
);
select assert_count(
  'same-org wrong-user cannot insert override',
  attempt_override_insert(
    '70000000-0000-0000-0000-000000000003',
    '60000000-0000-0000-0000-000000000001',
    'user-wrong'
  ),
  0
);

set request.jwt.claims = '{"org_id":"ws-unrelated","sub":"user-unrelated"}';
select assert_count('unrelated hooks', (select count(*) from hooks), 0);
select assert_count('unrelated runs', (select count(*) from runs), 1);
select assert_count('unrelated shares', (select count(*) from shared_bookmarks), 0);
select assert_count('unrelated saves', (select count(*) from saved_posts), 0);
select assert_count('unrelated overrides', (select count(*) from saved_post_overrides), 0);
reset role;

set role service_role;
set request.jwt.claims = '{}';
select assert_count('service hooks', (select count(*) from hooks), 2);
select assert_count('service runs', (select count(*) from runs), 3);
select assert_count('service backfills', (select count(*) from backfill_runs), 1);
select assert_count('service shares', (select count(*) from shared_bookmarks), 2);
select assert_count('service saves', (select count(*) from saved_posts), 2);
select assert_count('service overrides', (select count(*) from saved_post_overrides), 2);
reset role;

select assert_count(
  'readiness reports only fixture vector-index limitation',
  ((app_deployment_readiness() ->> 'compatible')::boolean)::integer,
  0
);
select assert_count(
  'readiness fixture missing count',
  jsonb_array_length(app_deployment_readiness() -> 'missing_capabilities'),
  1
);
select assert_count(
  'readiness validates vector index definition',
  (app_deployment_readiness() -> 'missing_capabilities' ? 'post_embeddings_cosine_idx')::integer,
  1
);
select assert_count(
  'readiness version',
  (app_deployment_readiness() ->> 'applied_version')::bigint,
  91
);

begin;
alter table hooks disable row level security;
select assert_count(
  'readiness detects RLS drift',
  (app_deployment_readiness() -> 'missing_capabilities' ? 'public.hooks(RLS enabled)')::integer,
  1
);
rollback;

begin;
drop policy saved_posts_isolation on saved_posts;
select assert_count(
  'readiness detects policy drift',
  (app_deployment_readiness() -> 'missing_capabilities' ? 'public.saved_posts.saved_posts_isolation')::integer,
  1
);
rollback;

begin;
create policy unexpected_public on hooks for select using (true);
select assert_count(
  'readiness detects unexpected permissive policy',
  (app_deployment_readiness() -> 'missing_capabilities' ? 'public.hooks.unexpected_public(unexpected policy)')::integer,
  1
);
rollback;

begin;
alter policy saved_posts_owner_write on saved_posts with check (true);
select assert_count(
  'readiness detects unsafe write check',
  (app_deployment_readiness() -> 'missing_capabilities' ? 'public.saved_posts.saved_posts_owner_write')::integer,
  1
);
rollback;

begin;
alter policy runs_isolation on runs to authenticated;
select assert_count(
  'readiness detects wrong policy role',
  (app_deployment_readiness() -> 'missing_capabilities' ? 'public.runs.runs_isolation')::integer,
  1
);
rollback;

begin;
alter policy runs_isolation on runs
  using (auth_workspace_id() is not null);
select assert_count(
  'readiness detects broadened same-name run policy',
  (app_deployment_readiness() -> 'missing_capabilities' ? 'public.runs.runs_isolation')::integer,
  1
);
rollback;

begin;
alter policy saved_posts_isolation on saved_posts
  using (workspace_id = auth_workspace_id() or auth_user_id() is not null or true);
select assert_count(
  'readiness detects OR-true saved-post policy',
  (app_deployment_readiness() -> 'missing_capabilities' ? 'public.saved_posts.saved_posts_isolation')::integer,
  1
);
rollback;

begin;
drop trigger workspace_accounts_manual_limit on workspace_accounts;
select assert_count(
  'readiness detects trigger drift',
  (app_deployment_readiness() -> 'missing_capabilities' ? 'public.workspace_accounts.workspace_accounts_manual_limit')::integer,
  1
);
rollback;

begin;
drop trigger protect_account_niche_trg on accounts;
create trigger protect_account_niche_trg before insert on accounts
for each row execute function protect_account_niche();
select assert_count(
  'readiness detects trigger definition drift',
  (app_deployment_readiness() -> 'missing_capabilities' ? 'public.accounts.protect_account_niche_trg')::integer,
  1
);
rollback;

begin;
alter table accounts enable replica trigger protect_account_niche_trg;
select assert_count(
  'readiness detects replica-only trigger',
  (app_deployment_readiness() -> 'missing_capabilities' ? 'public.accounts.protect_account_niche_trg')::integer,
  1
);
rollback;

begin;
drop index accounts_linkedin_handle_ci_unique;
select assert_count(
  'readiness detects index drift',
  (app_deployment_readiness() -> 'missing_capabilities' ? 'accounts_linkedin_handle_ci_unique')::integer,
  1
);
rollback;

begin;
drop index accounts_linkedin_handle_ci_unique;
create index accounts_linkedin_handle_ci_unique on accounts (linkedin_handle);
select assert_count(
  'readiness detects index definition drift',
  (app_deployment_readiness() -> 'missing_capabilities' ? 'accounts_linkedin_handle_ci_unique')::integer,
  1
);
rollback;

begin;
drop index accounts_linkedin_handle_ci_unique;
create unique index accounts_linkedin_handle_ci_unique
  on accounts (lower(linkedin_handle), id);
select assert_count(
  'readiness detects extra unique-index key',
  (app_deployment_readiness() -> 'missing_capabilities' ? 'accounts_linkedin_handle_ci_unique')::integer,
  1
);
rollback;

begin;
alter table accounts drop constraint accounts_category_id_fkey;
alter table accounts add constraint accounts_category_id_fkey
  foreign key (category_id) references categories(id) on delete cascade;
select assert_count(
  'readiness detects foreign-key definition drift',
  (app_deployment_readiness() -> 'missing_capabilities' ? 'public.accounts.accounts_category_id_fkey(on delete set null)')::integer,
  1
);
rollback;

begin;
alter table categories drop column created_at;
select assert_count(
  'readiness detects column drift',
  (app_deployment_readiness() -> 'missing_capabilities' ? 'public.categories.created_at')::integer,
  1
);
rollback;
