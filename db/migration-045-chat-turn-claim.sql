-- Migration 045: Add an EXCLUSIVE per-chat turn claim to claim_chat_turn
--
-- The duplicate-turn guard in the stream route rejects (a) identical-content
-- resubmits and (b) any user row newer than ~10s. But it does NOT stop a second,
-- DIFFERENT message from racing a slow/runaway first turn: if the first turn's
-- user row is already persisted and >10s old with no assistant reply yet, a new
-- message passes the dedup check, and claim_chat_turn only atomically serializes
-- the user-message INSERT + count caps — not an exclusive turn. Both runAgent
-- loops then run over overlapping history: two billed turns + a transcript whose
-- created_at ordering is nondeterministic.
--
-- Fix: claim the chat exclusively for one turn, inside the SAME per-workspace
-- advisory lock claim_chat_turn already holds, so the check-and-claim is atomic.
-- A new column `chats.turn_started_at` records the active turn's start:
--   * NULL                      → no turn in flight; claim it.
--   * set & younger than window → a turn is genuinely running; reject (409).
--   * set & older than window   → the previous turn's function instance died
--                                 (Vercel timeout/OOM) before it could release;
--                                 treat as stale and reclaim, so a chat can
--                                 never be permanently wedged "turn active".
--
-- The window (p_turn_timeout_secs, default 330s) sits just past the stream
-- route's maxDuration (300s) plus headroom, so a legitimately long turn is never
-- mistaken for dead. The stream route clears turn_started_at in its finally;
-- this staleness window is the backstop for the crash case.
--
-- Backward compatible via a DEFAULT on the new parameter. Idempotent.

alter table chats
  add column if not exists turn_started_at timestamptz;

create or replace function claim_chat_turn(
  p_workspace_id text,
  p_chat_id uuid,
  p_content text,
  p_hourly_limit int,
  p_daily_limit int,
  p_monthly_limit int default 2147483647,
  p_turn_timeout_secs int default 330
)
returns table (allowed boolean, reason text)
language plpgsql
as $$
declare
  v_hour_count int;
  v_day_count int;
  v_month_count int;
  v_turn_started timestamptz;
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

  -- Exclusive turn claim. Reject if a turn is already in flight for this chat
  -- and hasn't exceeded the staleness window (a still-running turn). A claim
  -- older than the window is from a dead instance and is reclaimed.
  select turn_started_at into v_turn_started
  from chats
  where id = p_chat_id and workspace_id = p_workspace_id
  for update;

  if v_turn_started is not null
     and v_turn_started > now() - make_interval(secs => p_turn_timeout_secs) then
    return query select false, 'turn_active';
    return;
  end if;

  update chats
  set turn_started_at = now()
  where id = p_chat_id and workspace_id = p_workspace_id;

  -- Under all caps and the turn is claimed — record the user message inside the
  -- lock so a racing request sees it in its own count.
  insert into chat_messages (chat_id, workspace_id, role, content)
  values (p_chat_id, p_workspace_id, 'user', p_content);

  return query select true, null::text;
end;
$$;
