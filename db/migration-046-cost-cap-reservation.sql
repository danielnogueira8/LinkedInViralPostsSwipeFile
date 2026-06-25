-- Migration 046: Close the monthly cost-cap TOCTOU with an in-flight reservation
--
-- checkChatRateLimit (app side) reads sum(usage_events.cost_usd) BEFORE the LLM
-- call, but usage is logged AFTER the turn. So N concurrent requests from one
-- workspace sitting just under the $25 cap each read below-budget spend and all
-- proceed, overshooting the cap by up to (N-1) × per-turn-cost in one cycle. The
-- message-count caps are already atomic in claim_chat_turn; the COST cap — the
-- actual money ceiling — was the only non-atomic one.
--
-- Fix: fold the cost check into claim_chat_turn, INSIDE the per-workspace
-- advisory lock it already holds, and account for in-flight turns. Migration 045
-- already records each active turn in chats.turn_started_at (with a staleness
-- window), so the count of non-stale active turns for a workspace IS the set of
-- turns whose cost hasn't landed in usage_events yet. We reserve a conservative
-- per-turn estimate for each:
--
--   committed = sum(usage_events.cost_usd this month, UTC)
--   inflight  = count(non-stale active turns for this workspace, INCLUDING the
--               one being claimed) × p_turn_cost_estimate
--   reject if committed + inflight > p_budget_usd
--
-- Because every concurrent claim runs under the same lock and sees the others'
-- turn_started_at, they can't all pass: each successive claim counts one more
-- in-flight turn, so the burst is bounded at the budget instead of N×over. When a
-- turn's real cost lands in usage_events and its claim is released (turn_started_at
-- → null), the reservation naturally converts to committed spend — no separate
-- reconcile step, no reservations table.
--
-- The estimate is deliberately conservative (default $0.05, ~1.5× a heavy
-- multi-tool turn's ~$0.035) so the cap errs toward blocking slightly early
-- rather than overshooting. A turn that ends up cheaper just frees its share the
-- moment it's released. p_budget_usd = 0 disables the cost check (back-compat).
--
-- Backward compatible via DEFAULTs on the new params. Idempotent.

create or replace function claim_chat_turn(
  p_workspace_id text,
  p_chat_id uuid,
  p_content text,
  p_hourly_limit int,
  p_daily_limit int,
  p_monthly_limit int default 2147483647,
  p_turn_timeout_secs int default 330,
  p_budget_usd numeric default 0,
  p_turn_cost_estimate numeric default 0.05
)
returns table (allowed boolean, reason text)
language plpgsql
as $$
declare
  v_hour_count int;
  v_day_count int;
  v_month_count int;
  v_turn_started timestamptz;
  v_stale_cutoff timestamptz;
  v_committed numeric;
  v_inflight_turns int;
begin
  -- Serialize concurrent claims for this workspace. hashtext() maps the
  -- workspace id to a lock key; the lock auto-releases at transaction end.
  perform pg_advisory_xact_lock(hashtext('chat_turn:' || p_workspace_id));

  v_stale_cutoff := now() - make_interval(secs => p_turn_timeout_secs);

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

  if v_turn_started is not null and v_turn_started > v_stale_cutoff then
    return query select false, 'turn_active';
    return;
  end if;

  -- Monthly COST cap with in-flight reservation. Only when a budget is set.
  -- committed = real spend this month; inflight = other non-stale active turns
  -- for this workspace (whose cost hasn't landed yet) PLUS this one, each
  -- reserved at the conservative per-turn estimate. Concurrent claims serialize
  -- through the lock and each see the others' turn_started_at, so they can't all
  -- pass — the burst is bounded at the budget.
  if p_budget_usd > 0 then
    select coalesce(sum(cost_usd), 0) into v_committed
    from usage_events
    where workspace_id = p_workspace_id
      and ts >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';

    -- Count OTHER chats with a non-stale active turn, then +1 for this turn.
    select count(*) into v_inflight_turns
    from chats
    where workspace_id = p_workspace_id
      and id <> p_chat_id
      and turn_started_at is not null
      and turn_started_at > v_stale_cutoff;
    v_inflight_turns := v_inflight_turns + 1;

    if v_committed + (v_inflight_turns * p_turn_cost_estimate) > p_budget_usd then
      return query select false, 'monthly';
      return;
    end if;
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
