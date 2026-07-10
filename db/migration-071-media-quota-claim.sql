-- Migration 071: Atomic workspace media quota reservations

create table if not exists media_quota_claims (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  size_bytes bigint not null check (size_bytes > 0),
  status text not null default 'reserved'
    check (status in ('reserved', 'completed', 'released')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists media_quota_claims_active_idx
  on media_quota_claims (workspace_id, created_at)
  where status = 'reserved';

alter table media_quota_claims enable row level security;

drop policy if exists media_quota_claims_isolation on media_quota_claims;
create policy media_quota_claims_isolation on media_quota_claims
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());

create or replace function claim_media_quota(
  p_workspace_id text,
  p_size_bytes bigint,
  p_limit_bytes bigint
)
returns table (claim_id uuid, used_before bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used bigint;
  v_claim_id uuid;
begin
  if p_size_bytes < 1 or p_limit_bytes < 1 then
    raise exception 'Media quota values must be positive';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('media-quota:' || p_workspace_id, 0));

  update media_quota_claims
  set status = 'released', updated_at = now()
  where workspace_id = p_workspace_id
    and status = 'reserved'
    and created_at < now() - interval '15 minutes';

  select
    coalesce((select sum(size_bytes) from media_assets
      where workspace_id = p_workspace_id and deleted_at is null), 0)
    +
    coalesce((select sum(size_bytes) from media_quota_claims
      where workspace_id = p_workspace_id and status = 'reserved'), 0)
  into v_used;

  if v_used + p_size_bytes > p_limit_bytes then
    return;
  end if;

  insert into media_quota_claims (workspace_id, size_bytes)
  values (p_workspace_id, p_size_bytes)
  returning id into v_claim_id;

  return query select v_claim_id, v_used;
end;
$$;

revoke all on function claim_media_quota(text, bigint, bigint) from public;
revoke all on function claim_media_quota(text, bigint, bigint) from anon;
revoke all on function claim_media_quota(text, bigint, bigint) from authenticated;
grant execute on function claim_media_quota(text, bigint, bigint) to service_role;
