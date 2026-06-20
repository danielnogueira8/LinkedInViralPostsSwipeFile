-- Migration 036: Chat workspace (Claude-Cowork-style chat UI)
--
-- Replaces the insights dashboard's home with a conversational workspace where
-- users run the content workflows (search the swipe file, mimic a viral post,
-- create original content) directly in-app via a tool-calling agent on
-- GLM-5.1 (OpenRouter), instead of copy-pasting prompts into Claude + MCP.
--
-- Tables:
--   chats           — one conversation thread per (workspace, title). Many per
--                     workspace; the left sidebar lists them.
--   chat_messages   — the turn-by-turn transcript. Stores tool calls + the
--                     artifacts the agent produced so a chat reloads exactly.
--   chat_artifacts  — generated posts the user explicitly saved out of a chat
--                     (the right-hand artifact panel's "Save" action).
--
-- Also: usage_events gains workspace_id so per-workspace chat spend is
-- attributable (drives the unlimited + rate-limit cost model).
--
-- Multi-tenancy mirrors migration 011 / 016: workspace_id = Clerk org_id,
-- RLS on, isolation via auth_workspace_id(). App-layer scoping in
-- lib/supabase-scoped.ts is the belt to RLS's suspenders.
--
-- Idempotent and safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. chats: one conversation thread
-- ---------------------------------------------------------------------------
create table if not exists chats (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  -- Human title shown in the sidebar. Defaults to "New chat"; auto-named from
  -- the first user message (or left as-is) by the app.
  title text not null default 'New chat',
  -- Soft-delete: archived chats drop out of the sidebar but the transcript is
  -- retained. Mirrors the archived_at pattern used elsewhere (accounts, voice).
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  -- Bumped on every new message so the sidebar can sort by recency.
  updated_at timestamptz not null default now()
);

create index if not exists chats_workspace_recency_idx
  on chats(workspace_id, updated_at desc);

-- ---------------------------------------------------------------------------
-- 2. chat_messages: the transcript
-- ---------------------------------------------------------------------------
create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references chats(id) on delete cascade,
  -- Denormalized for RLS + cheap workspace-scoped queries without a join.
  workspace_id text not null,
  -- 'user' | 'assistant' | 'tool'. 'system' is never persisted (it's rebuilt
  -- from the voice/swipe context on each run, and kept out of the cached
  -- transcript so it doesn't bloat history).
  role text not null check (role in ('user', 'assistant', 'tool')),
  -- The visible text content. For a 'tool' message this is the JSON result the
  -- tool returned (stringified); for assistant/user it's the markdown body.
  content text not null default '',
  -- Assistant tool-call requests for this turn, in OpenAI tool_calls shape:
  -- [{ id, type:'function', function:{ name, arguments } }]. Null when the
  -- assistant only produced text.
  tool_calls jsonb,
  -- For a 'tool' message: which assistant tool_call id this result answers.
  tool_call_id text,
  -- Artifacts (generated posts) the assistant surfaced in this turn, so the
  -- right panel rehydrates on reload: [{ id, kind:'post', title, body, meta }].
  artifacts jsonb,
  -- Per-message token accounting (mirrors usage_events granularity) so a chat
  -- can show its own cost and the rate-limiter can sum recent spend cheaply.
  input_tokens int,
  output_tokens int,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_chat_idx
  on chat_messages(chat_id, created_at asc);
create index if not exists chat_messages_workspace_recency_idx
  on chat_messages(workspace_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. chat_artifacts: generated posts the user saved out of a chat
-- ---------------------------------------------------------------------------
-- Distinct from saved_posts (which bookmarks *external* viral posts by URL).
-- These are the user's *own* drafts produced by the agent, kept so the
-- artifact panel and a future "my drafts" view can list them.
create table if not exists chat_artifacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  -- Where it came from (nullable so deleting a chat doesn't delete a saved draft).
  chat_id uuid references chats(id) on delete set null,
  message_id uuid references chat_messages(id) on delete set null,
  kind text not null default 'post' check (kind in ('post')),
  title text,
  body text not null,
  -- Free-form metadata: which workflow produced it, source post id, hook, etc.
  meta jsonb,
  saved_by text,                    -- clerk user id; nullable to survive user delete
  created_at timestamptz not null default now()
);

create index if not exists chat_artifacts_workspace_recency_idx
  on chat_artifacts(workspace_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 4. usage_events: attribute spend to a workspace
-- ---------------------------------------------------------------------------
-- Pre-existing usage_events had no workspace_id (cost was global). Chat spend
-- must be per-workspace for the rate-limit model, so add it nullable
-- (background/cron usage stays null = global).
alter table usage_events add column if not exists workspace_id text;
create index if not exists usage_events_workspace_ts_idx
  on usage_events(workspace_id, ts desc);

-- Broaden the provider check to allow 'openrouter' alongside the existing set.
-- (Drop + re-add because Postgres can't ALTER a check constraint in place.)
alter table usage_events drop constraint if exists usage_events_provider_check;
alter table usage_events
  add constraint usage_events_provider_check
  check (provider in ('anthropic', 'apify', 'openrouter'));

-- ---------------------------------------------------------------------------
-- 5. RLS — isolation via auth_workspace_id(), mirroring migration 011 / 016
-- ---------------------------------------------------------------------------
alter table chats enable row level security;
drop policy if exists chats_isolation on chats;
create policy chats_isolation on chats
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());

alter table chat_messages enable row level security;
drop policy if exists chat_messages_isolation on chat_messages;
create policy chat_messages_isolation on chat_messages
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());

alter table chat_artifacts enable row level security;
drop policy if exists chat_artifacts_isolation on chat_artifacts;
create policy chat_artifacts_isolation on chat_artifacts
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());
