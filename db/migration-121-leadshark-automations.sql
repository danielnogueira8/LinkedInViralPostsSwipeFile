-- Migration 121: LeadShark automations.
--
-- One row per lead-magnet draft the user has configured for comment-triggered
-- auto-DM. Created at CONFIGURE time (before the post exists); the binding job
-- fills in the LinkedIn URN + LeadShark automation id once the post publishes.
--
-- No FK to chat_artifacts — consistent with the existing FK-free lead-magnet
-- links (chat_messages.lead_magnet_id, chat_artifacts.meta.lead_magnet).
--
-- `stats` holds COUNTS ONLY — no commenter names/profiles. That is what keeps
-- GDPR exposure at zero. `urn_snapshot` persists the pre-publish post list so a
-- retried binding job doesn't need to re-derive it (it CAN'T be re-derived once
-- the post is live).

begin;

create table if not exists public.leadshark_automations (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  artifact_id uuid not null,           -- chat_artifacts.id (no FK, by design)
  lead_magnet_id uuid,                 -- lead_magnets.id, source of the DM URL

  -- Trigger. Empty array is meaningful: "respond to all comments".
  keywords text[] not null default '{}',

  -- DM: primary + rotated variations.
  dm_template text not null,
  dm_template_variations text[] not null default '{}',

  -- Comment replies.
  comment_reply_templates text[] not null default '{}',
  non_connection_reply_templates text[] not null default '{}',

  -- Engagement.
  auto_connect boolean not null default false,
  auto_like boolean not null default false,

  -- Follow-up.
  follow_up_enabled boolean not null default false,
  follow_up_template text,
  follow_up_delay_minutes integer not null default 60,
  follow_up_only_if_no_response boolean not null default true,

  -- What Zernio gives us at publish time.
  zernio_post_url text,                -- platformPostUrl, the LinkedIn permalink
  zernio_post_urn text,                -- platformPostId, e.g. urn:li:share:748...

  -- What LeadShark needs. NOT the same URN namespace as zernio_post_urn — the
  -- binding job resolves the activity URN from LeadShark (see the build plan §6).
  linkedin_post_urn text,              -- urn:li:activity:...
  linkedin_post_url text,              -- LeadShark's share_url for the same post
  leadshark_automation_id text,

  urn_snapshot text[],                 -- pre-publish post list (fallback path only)
  bind_attempts integer not null default 0,

  status text not null default 'configured' check (status in (
    'configured', 'binding', 'awaiting_urn',
    'active', 'paused', 'failed', 'deleted'
  )),
  last_error text,
  last_error_code text,

  stats jsonb not null default '{}'::jsonb,   -- counts only, no PII
  stats_synced_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, artifact_id)
);

create index if not exists leadshark_automations_workspace_status_idx
  on public.leadshark_automations (workspace_id, status);

-- Partial index for the hourly stats-sync drain: only active automations.
create index if not exists leadshark_automations_active_sync_idx
  on public.leadshark_automations (stats_synced_at)
  where status = 'active';

alter table public.leadshark_automations enable row level security;

drop policy if exists leadshark_automations_isolation on public.leadshark_automations;
create policy leadshark_automations_isolation on public.leadshark_automations
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 121, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
