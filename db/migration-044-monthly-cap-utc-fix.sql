-- Migration 044: Fix the monthly message-cap window to be truly UTC
--
-- Migration 042 computes the calendar-month boundary as:
--     date_trunc('month', now() at time zone 'UTC')
-- `now() at time zone 'UTC'` yields a bare `timestamp` (the UTC wall-clock) and
-- `date_trunc` returns a bare `timestamp`. Comparing that to `created_at` (a
-- `timestamptz`) forces an implicit cast of the bare timestamp BACK to
-- `timestamptz` using the database SESSION's TimeZone setting — not UTC. If the
-- session TZ isn't UTC, the month boundary shifts by the offset, so the message
-- cap and the app-side cost cap (startOfMonthIso() → Date.UTC(...), genuinely
-- UTC) disagree on which month a message belongs to near the 1st.
--
-- Fix: anchor the boundary in UTC explicitly by converting the truncated
-- wall-clock back to timestamptz AS UTC:
--     date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'
-- This is session-TimeZone-independent and matches startOfMonthIso() exactly, so
-- the message cap and cost cap reset together as the 042 comment intended.
--
-- Idempotent: create or replace. Only the monthly window expression changes.

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
  -- in UTC, matching the app's monthly cost-cap window. The trailing
  -- `at time zone 'UTC'` re-anchors the truncated wall-clock as a UTC
  -- timestamptz so the boundary is independent of the DB session TimeZone.
  select count(*) into v_month_count
  from chat_messages
  where workspace_id = p_workspace_id
    and role = 'user'
    and created_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';

  if v_month_count >= p_monthly_limit then
    return query select false, 'monthly_messages';
    return;
  end if;

  -- Passed all caps: record the user turn and allow it.
  insert into chat_messages (chat_id, workspace_id, role, content)
  values (p_chat_id, p_workspace_id, 'user', p_content);

  return query select true, null::text;
end;
$$;
