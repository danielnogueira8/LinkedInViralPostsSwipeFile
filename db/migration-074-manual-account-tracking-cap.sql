-- Migration 074: Enforce the per-workspace manual creator cap atomically.

create or replace function enforce_workspace_manual_account_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source text;
  v_count integer;
  v_limit constant integer := 50;
begin
  select source into v_source
  from accounts
  where id = new.account_id
    and archived_at is null;

  if v_source is null then
    raise exception 'account_not_found_or_archived' using errcode = 'P0001';
  end if;

  if v_source <> 'manual' then
    return new;
  end if;

  -- Serialize manual membership inserts for one workspace. This makes the
  -- count and insert one atomic capacity claim even across parallel requests.
  perform pg_advisory_xact_lock(
    hashtextextended('manual-account-limit:' || new.workspace_id, 0)
  );

  -- Idempotent upserts for an already tracked creator do not consume a slot.
  if exists (
    select 1 from workspace_accounts
    where workspace_id = new.workspace_id
      and account_id = new.account_id
  ) then
    return new;
  end if;

  select count(*) into v_count
  from workspace_accounts wa
  join accounts a on a.id = wa.account_id
  where wa.workspace_id = new.workspace_id
    and a.source = 'manual';

  if v_count >= v_limit then
    raise exception 'manual_account_limit:%', v_limit using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists workspace_accounts_manual_limit on workspace_accounts;
create trigger workspace_accounts_manual_limit
before insert on workspace_accounts
for each row execute function enforce_workspace_manual_account_limit();

revoke all on function enforce_workspace_manual_account_limit() from public;
revoke all on function enforce_workspace_manual_account_limit() from anon;
revoke all on function enforce_workspace_manual_account_limit() from authenticated;
