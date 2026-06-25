-- Migration 042: Add an enforced MONTHLY message cap to claim_chat_turn
--
-- Product change: surface a per-workspace "credits" counter (🪙 used/limit) and
-- make that number the BINDING limit — a monthly message allowance, not just a
-- display. The hourly (burst brake) and daily (smoothing) caps stay; this adds
-- a third count cap: messages in the current CALENDAR month.
--
-- Enforced inside claim_chat_turn for the same reason as the others: the
-- count-and-insert must be atomic under the per-workspace advisory lock, or N
-- concurrent requests could each read a below-limit count and all slip past
-- (the TOCTOU migration 038 closed). Counting chat_messages (role='user') is
-- the synchronous signal — usage_events is logged fire-and-forget AFTER a turn,
-- so it would undercount an in-flight burst.
--
-- "Calendar month" = from date_trunc('month', now()) in UTC, matching the
-- monthly COST cap's startOfMonthIso() (app side). The two reset together.
--
-- Backward compatible via a DEFAULT on the new parameter: existing callers that
-- don't pass p_monthly_limit get a no-op (very high) cap until the app is
-- updated to pass it. Idempotent: create or replace.

create or replace function claim_chat_turn(
  p_workspace_id text,
  p_chat_id uuid,
  p_content text,
  p_hourly_limit int,
  p_daily_limit int,
  p_monthly_limit int default 2147483647
)
returns table (allowed boolean, reason text)
language plpgsql
as $$
declare
  v_hour_count int;
  v_day_count int;
  v_month_count int;
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

  -- Monthly message allowance (the user-visible "credits" cap). Calendar month
  -- in UTC, matching the app's monthly cost-cap window.
  select count(*) into v_month_count
  from chat_messages
  where workspace_id = p_workspace_id
    and role = 'user'
    and created_at >= date_trunc('month', now() at time zone 'UTC');

  if v_month_count >= p_monthly_limit then
    return query select false, 'monthly_messages';
    return;
  end if;

  -- Under all caps — record the turn inside the lock so a racing request sees
  -- it in its own count.
  insert into chat_messages (chat_id, workspace_id, role, content)
  values (p_chat_id, p_workspace_id, 'user', p_content);

  return query select true, null::text;
end;
$$;
