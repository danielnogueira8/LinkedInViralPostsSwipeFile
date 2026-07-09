-- ---------------------------------------------------------------------------
-- RLS backfill: enable Row Level Security on the three user-content tables
-- that were missed by earlier migrations.
--
-- Context: the app's tenant isolation is enforced at two layers:
--   1. App layer — every helper in lib/supabase-scoped.ts stamps/filters
--      `workspace_id` via requireWorkspaceId() → Clerk org_id.
--   2. Postgres RLS — policies via auth_workspace_id() (migration 011)
--      block cross-tenant reads even if the app-layer filter is dropped.
--
-- Layer 2 was set up for most tables in migrations 011, 016, 021, 036, 057,
-- and elsewhere — but three user tables slipped through and were relying on
-- layer 1 alone: voice_profiles, hooks, usage_events. This migration closes
-- that gap.
--
-- No breakage: every current caller of these tables uses either
-- `supabaseAdmin()` (service role, bypasses RLS) or `scopedSupabase.raw`
-- (which is a service-role client under the hood — see lib/supabase-scoped.ts
-- L9). So this is defense-in-depth for future user-JWT paths, with zero
-- runtime effect on today's code.
--
-- backfill_runs is deliberately NOT included — it's a global,
-- workspace-agnostic table (site-wide backfill jobs, no workspace_id
-- column). It's guarded at the API layer by the isAdmin() gate on
-- /api/backfill-hooks, /api/backfill-post-types, /api/backfill-saved-posts,
-- and /api/backfill-status (PR #791).
-- ---------------------------------------------------------------------------

-- =============================================================================
-- 1. voice_profiles — per-workspace direct isolation.
-- =============================================================================
alter table voice_profiles enable row level security;
drop policy if exists voice_profiles_isolation on voice_profiles;
create policy voice_profiles_isolation on voice_profiles
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());

-- =============================================================================
-- 2. hooks — global (extracted from `posts`, one hook per post). Follows the
--    same "readable via workspace_accounts tracking" pattern as posts itself
--    (migration 011). A workspace can read a hook if it tracks the underlying
--    post's account. No public write policy — inserts happen via the pipeline
--    under supabaseAdmin() which bypasses RLS anyway.
-- =============================================================================
alter table hooks enable row level security;
drop policy if exists hooks_read_via_tracking on hooks;
create policy hooks_read_via_tracking on hooks
  for select using (
    exists (
      select 1
      from posts p
      join workspace_accounts wa on wa.account_id = p.account_id
      where p.id = hooks.post_id
        and wa.workspace_id = auth_workspace_id()
    )
  );

-- =============================================================================
-- 3. usage_events — per-workspace cost/spend rows (workspace_id added in
--    migration 036). Cron/global rows (workspace_id IS NULL) are visible only
--    to admin/service-role clients, which is correct for the daily digest.
-- =============================================================================
alter table usage_events enable row level security;
drop policy if exists usage_events_isolation on usage_events;
create policy usage_events_isolation on usage_events
  for select using (workspace_id = auth_workspace_id());
-- No insert/update/delete policy: every write goes through supabaseAdmin()
-- (see lib/openrouter.ts:logOpenRouterUsage, lib/usage.ts:logAnthropicUsage /
-- logApifyUsage, lib/zernio.ts) which bypasses RLS. Denying user-JWT writes
-- here prevents a future accidental user-role insert from spoofing spend.
