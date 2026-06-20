-- Migration 038: Atomic chat-turn claim (close the rate-limit TOCTOU)
--
-- The hourly/daily message caps were enforced as "count rows, then insert the
-- user message" across two separate statements. N concurrent requests from one
-- workspace could each read a below-limit count and all pass before any insert
-- landed, blowing past the caps.
--
-- claim_chat_turn() does the count-and-insert atomically under a per-workspace
-- transaction-scoped advisory lock, so concurrent requests for the same
-- workspace serialize: each sees the inserts of the ones before it. It inserts
-- the user message only when under both caps, and reports which cap (if any)
-- was hit so the route can return the right message. The monthly COST cap stays
-- in app code (it already fails closed and is far less race-sensitive).
--
-- Idempotent: create or replace.

create or replace function claim_chat_turn(
  p_workspace_id text,
  p_chat_id uuid,
  p_content text,
  p_hourly_limit int,
  p_daily_limit int
)
returns table (allowed boolean, reason text)
language plpgsql
as $$
declare
  v_hour_count int;
  v_day_count int;
begin
  -- Serialize concurrent claims for this workspace. hashtext() maps the
  -- workspace id to a lock key; the lock auto-releases at transaction end.
  perform pg_advisory_xact_lock(hashtext('chat_turn:' || p_workspace_id));

  select count(*) into v_hour_count
  from chat_messages
  where workspace_id = p_workspace_id
    and role = 'user'
    and created_at >= now() - interval '1 hour';

  if v_hour_count >= p_hourly_limit then
    return query select false, 'hourly';
    return;
  end if;

  select count(*) into v_day_count
  from chat_messages
  where workspace_id = p_workspace_id
    and role = 'user'
    and created_at >= now() - interval '24 hours';

  if v_day_count >= p_daily_limit then
    return query select false, 'daily';
    return;
  end if;

  -- Under both caps — record the turn inside the lock so a racing request sees
  -- it in its own count.
  insert into chat_messages (chat_id, workspace_id, role, content)
  values (p_chat_id, p_workspace_id, 'user', p_content);

  return query select true, null::text;
end;
$$;
