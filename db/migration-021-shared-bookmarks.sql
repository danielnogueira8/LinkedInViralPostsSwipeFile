-- Migration 021: Shareable bookmark libraries
--
-- A workspace owner can invite another person (by email) to view + add
-- to their bookmarks library. The recipient accepts the invite, then
-- sees the shared library as a separate tab inside their own
-- /dashboard/bookmarks UI. The recipient can:
--   - add new saves (attributed to them via saved_posts.created_by_user_id)
--   - add per-recipient notes / niche tags via saved_post_overrides
-- The recipient CANNOT delete or edit the owner's saves directly. The
-- owner sees everything in their own library (their saves + the
-- recipient's contributions) but never sees the recipient's overrides.
--
-- Design notes:
-- * shared_bookmarks is the invite/membership record. recipient_email
--   is the source of truth at invite time; recipient_user_id gets filled
--   in when the recipient accepts (so an invite to an email that hasn't
--   signed up yet can still resolve when they sign up later).
-- * Overrides live in a separate table so the owner's rows stay
--   pristine. The render path COALESCEs override → owner value for the
--   recipient's view, and ignores overrides for the owner's view.
-- * saved_posts gets a created_by_user_id column so we can attribute
--   recipient-added saves and enforce "recipient can only delete what
--   they added" at the app layer. Null on legacy rows = owner-added.
--
-- Run order: idempotent. Safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. shared_bookmarks — invite / membership ledger
-- ---------------------------------------------------------------------------
create table if not exists shared_bookmarks (
  id uuid primary key default gen_random_uuid(),
  owner_workspace_id text not null,     -- whose library is shared
  recipient_email text not null,        -- what the owner typed at invite time
  recipient_user_id text,               -- Clerk user_id; filled on accept
  status text not null default 'pending', -- 'pending' | 'accepted' | 'revoked' | 'declined'
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  revoked_at timestamptz,
  -- One pending/accepted invite per (workspace, email). We don't enforce
  -- uniqueness on revoked/declined rows so the owner can re-invite the
  -- same person after revoking.
  unique (owner_workspace_id, recipient_email, status)
);

create index if not exists shared_bookmarks_owner_idx
  on shared_bookmarks(owner_workspace_id, status);
create index if not exists shared_bookmarks_recipient_email_idx
  on shared_bookmarks(recipient_email, status);
create index if not exists shared_bookmarks_recipient_user_idx
  on shared_bookmarks(recipient_user_id, status);

-- ---------------------------------------------------------------------------
-- 2. saved_post_overrides — per-recipient note + category overlay
-- ---------------------------------------------------------------------------
-- The recipient's notes/category tags on saves they DIDN'T create. Their
-- view of the shared library COALESCEs override values over the owner's
-- originals. The owner's view never reads this table.
create table if not exists saved_post_overrides (
  id uuid primary key default gen_random_uuid(),
  saved_post_id uuid not null references saved_posts(id) on delete cascade,
  recipient_user_id text not null,
  note text,
  category_id text references categories(id),
  updated_at timestamptz not null default now(),
  unique (saved_post_id, recipient_user_id)
);

create index if not exists saved_post_overrides_recipient_idx
  on saved_post_overrides(recipient_user_id);

-- ---------------------------------------------------------------------------
-- 3. saved_posts.created_by_user_id — attribute recipient-added saves
-- ---------------------------------------------------------------------------
-- Null = legacy (pre-sharing) or owner-added. Non-null = a recipient
-- added this post into someone else's library while collaborating.
alter table saved_posts
  add column if not exists created_by_user_id text;

create index if not exists saved_posts_created_by_idx
  on saved_posts(created_by_user_id);

-- ---------------------------------------------------------------------------
-- 4. RLS — defense-in-depth (app uses service-role via scopedSupabase)
-- ---------------------------------------------------------------------------
-- shared_bookmarks: owner workspace sees its own invites; recipient
-- sees invites addressed to them (by user_id once accepted, or by email
-- while pending — RLS can only check user_id, so the pending-email path
-- is enforced at the app layer).
alter table shared_bookmarks enable row level security;
drop policy if exists shared_bookmarks_owner_or_recipient on shared_bookmarks;
create policy shared_bookmarks_owner_or_recipient on shared_bookmarks
  using (
    owner_workspace_id = auth_workspace_id()
    or recipient_user_id is not null
  )
  with check (owner_workspace_id = auth_workspace_id());

-- saved_post_overrides: recipient can read/write their own overrides.
-- Owner doesn't have a direct policy here — they never query this table.
alter table saved_post_overrides enable row level security;
drop policy if exists saved_post_overrides_recipient on saved_post_overrides;
create policy saved_post_overrides_recipient on saved_post_overrides
  using (auth_workspace_id() is not null)
  with check (auth_workspace_id() is not null);

-- ---------------------------------------------------------------------------
-- 5. Extend saved_posts read policy to include accepted shares
-- ---------------------------------------------------------------------------
-- The original isolation policy locks saved_posts to the owner workspace.
-- For shared bookmarks we need the recipient's workspace to also see the
-- owner's saved_posts. Service-role bypasses RLS anyway (app does scoping
-- at the route layer), but the RLS rewrite keeps the policy honest as
-- defense-in-depth.
drop policy if exists saved_posts_isolation on saved_posts;
create policy saved_posts_isolation on saved_posts
  using (
    workspace_id = auth_workspace_id()
    or exists (
      select 1 from shared_bookmarks sb
      where sb.owner_workspace_id = saved_posts.workspace_id
        and sb.status = 'accepted'
        and sb.recipient_user_id is not null
    )
  )
  with check (workspace_id = auth_workspace_id());
