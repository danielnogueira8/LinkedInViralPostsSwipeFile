-- Migration 057: LinkedIn publishing via Zernio (scheduling foundation)
--
-- Turns the Posts board's EXISTING calendar (plan_to_post_on, a planning-only
-- date) into real, timed auto-publishing to LinkedIn through the Zernio API.
--
-- What this adds:
--   publishing_connections — one row per (workspace, network) linking the
--     workspace to its Zernio LinkedIn account. The zernio_account_id is NOT a
--     secret, but it IS workspace data: every publish resolves it from the
--     caller's workspace_id, never from client input (a client-supplied account
--     id would be a post-to-someone-else's-LinkedIn IDOR).
--   chat_artifacts.scheduled_at / schedule_status / … — a PRECISE, committed
--     publish schedule, distinct from plan_to_post_on (which stays the soft
--     planning date that drives the calendar's day-bucketing + board sort).
--     null schedule_status = not auto-scheduled (today's planning-only behavior,
--     preserved). Setting a real schedule ALSO sets plan_to_post_on to its date
--     so the existing calendar shows it with no extra work.
--
-- The cron (/api/cron/publish-scheduled) scans schedule_status='scheduled' rows
-- whose scheduled_at has passed, publishes via Zernio, and flips the board
-- status to 'posted'. Our DB stays the single source of truth: cancel /
-- reschedule / edit-after-schedule is a plain DB update until the moment of
-- publish.
--
-- Multi-tenancy mirrors migration 036 / 011: workspace_id = Clerk org_id, RLS
-- on, isolation via auth_workspace_id(). App-layer scoping (scopedSupabase) is
-- the belt to RLS's suspenders.
--
-- Idempotent and safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. publishing_connections: workspace → Zernio LinkedIn account
-- ---------------------------------------------------------------------------
create table if not exists publishing_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  -- Which social network this connection publishes to. Only 'linkedin' today;
  -- the column future-proofs for more and keeps the unique key meaningful.
  network text not null default 'linkedin',
  -- The account id Zernio assigns to the connected LinkedIn account. Passed to
  -- POST /v1/posts. Resolved server-side from workspace_id — never client input.
  zernio_account_id text not null,
  -- Display metadata for the Settings card (who's connected).
  display_name text,
  avatar_url text,
  -- 'personal' (a profile) or 'organization' (a company page). v1 is personal.
  account_type text not null default 'personal'
    check (account_type in ('personal', 'organization')),
  -- 'active' → can publish. 'disconnected' → the token was revoked/expired (the
  -- publisher flips this on a token-expiry error) or the user disconnected; the
  -- Settings card then shows Reconnect.
  status text not null default 'active'
    check (status in ('active', 'disconnected')),
  disconnected_reason text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One LinkedIn connection per workspace in v1 (the upsert target).
create unique index if not exists publishing_connections_ws_network_idx
  on publishing_connections(workspace_id, network);

-- ---------------------------------------------------------------------------
-- 2. chat_artifacts: the committed publish schedule
-- ---------------------------------------------------------------------------
-- scheduled_at is a precise instant (unlike plan_to_post_on, a YYYY-MM-DD date).
-- schedule_status null = planning-only (today's behavior). The lifecycle is
-- scheduled → publishing (claimed by the cron) → published | failed.
alter table chat_artifacts add column if not exists scheduled_at timestamptz;
alter table chat_artifacts add column if not exists schedule_status text
  check (schedule_status in ('scheduled', 'publishing', 'published', 'failed'));
-- Zernio's post id, returned on a successful publish (for a "View on LinkedIn"
-- link + de-dup / audit).
alter table chat_artifacts add column if not exists zernio_post_id text;
alter table chat_artifacts add column if not exists published_at timestamptz;
-- A human-readable failure reason (mapped from Zernio's error), shown on the
-- failed chip.
alter table chat_artifacts add column if not exists publish_error text;
-- How many times the cron has attempted this row. Transient failures may retry
-- up to a cap; a duplicate (422) is permanent and never retried.
alter table chat_artifacts add column if not exists publish_attempts int not null default 0;
-- Optional first comment auto-posted after publish. Best practice for external
-- links (LinkedIn suppresses in-body links ~40-50%).
alter table chat_artifacts add column if not exists first_comment text;

-- The cron's due-scan target: only 'scheduled' rows, ordered by when they fire.
-- A partial index keeps it cheap even as published/failed rows accumulate.
create index if not exists chat_artifacts_due_schedule_idx
  on chat_artifacts(schedule_status, scheduled_at)
  where schedule_status = 'scheduled';

-- ---------------------------------------------------------------------------
-- 3. usage_events: attribute Zernio publish spend to a workspace
-- ---------------------------------------------------------------------------
-- Broaden the provider check to allow 'zernio' alongside the existing set.
-- (Drop + re-add — Postgres can't ALTER a check constraint in place. Must list
-- EVERY allowed value, since this replaces the whole constraint.)
alter table usage_events drop constraint if exists usage_events_provider_check;
alter table usage_events
  add constraint usage_events_provider_check
  check (provider in ('anthropic', 'apify', 'openrouter', 'zernio'));

-- ---------------------------------------------------------------------------
-- 4. RLS — isolation via auth_workspace_id(), mirroring migration 036
-- ---------------------------------------------------------------------------
alter table publishing_connections enable row level security;
drop policy if exists publishing_connections_isolation on publishing_connections;
create policy publishing_connections_isolation on publishing_connections
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());
