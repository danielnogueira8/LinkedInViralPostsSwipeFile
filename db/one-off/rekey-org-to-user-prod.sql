-- ============================================================================
-- ONE-OFF DATA RE-KEY: workspace_id  org_...  →  user_...  (production)
--
-- Companion to migration-098 (which switched the app + RLS to user-id
-- workspaces). This remaps the EXISTING prod rows from the old Clerk org id to
-- the Clerk user id. Run ONCE, in the SAME window as deploying the PR — until
-- both land, the app queries `workspace_id = user_...` while the data still says
-- `org_...`, so the workspace looks empty in between.
--
--   OLD (org): org_3GakrmAVKMpNIR5jipFPeAVnDyf
--   NEW (user): user_3GakrmqrbJ7DbKiyvbCmkMokcbK
--
-- This is a single-user prod workspace, so it's a clean 1:1 org→user swap with
-- NO merge conflicts (unlike the earlier dev→prod merge). Every table gets a
-- plain UPDATE; the composite-unique tables can't collide because one org maps
-- to exactly one user that owns no rows under any other id.
--
-- Org ids are inlined as string literals (NOT psql \set vars) so they also work
-- if any DO $$ block is added later. Run as ONE transaction. Snapshot the DB
-- first (Supabase → Database → Backups). To PREVIEW, change COMMIT to ROLLBACK
-- and read the NOTICE counts.
-- ============================================================================

begin;

-- guard: refuse if the two ids are equal
do $$
begin
  if 'org_3GakrmAVKMpNIR5jipFPeAVnDyf' = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' then
    raise exception 'OLD == NEW';
  end if;
end $$;

-- ---- workspace_id columns (every workspace-scoped table) ----
update public.workspace_accounts            set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.settings                      set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.saved_posts                   set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.voice_profiles                set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.categories                    set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.custom_skills                 set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.batch_runs                    set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.workspace_post_classification set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.post_analytics                set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.publishing_connections        set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.clients                       set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.image_prompts                 set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.chats                         set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.chat_messages                 set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.chat_artifacts                set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.chat_modeling_sources         set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.content_templates             set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.content_preferences           set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.batch_draft_slots             set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.creator_style_profiles        set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.creator_style_profile_sources set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.content_feedback              set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.media_assets                  set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.lead_magnets                  set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.background_jobs               set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.provider_locks                set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.usage_events                  set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';  -- nullable: global rows stay NULL
update public.runs                          set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';  -- nullable: global cron rows stay NULL
-- transient claim/lock/cache tables (self-expiring; re-key for completeness)
update public.ai_operation_claims           set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.image_analysis_cache          set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.workspace_cost_claims         set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.freshness_constraint_cache    set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.lead_magnet_generation_claims set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.media_quota_claims            set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.chat_action_checkpoints       set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.chat_action_retry_contexts    set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
update public.chat_action_turn_controls     set workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';

-- ---- shared-bookmarks: owner column is owner_workspace_id (the owner's workspace) ----
update public.shared_bookmarks              set owner_workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where owner_workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';

-- ---- accounts: the shared catalog — only re-key rows this workspace manually owns ----
update public.accounts                      set manual_owner_workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK' where manual_owner_workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';

-- ---- verify + report (should all be 0 on the OLD org after the re-key) ----
do $$
declare c_chats int; c_settings int; c_saved int; c_wa int; c_voice int; c_pub int; c_acct int;
begin
  select count(*) into c_chats    from public.chats                  where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
  select count(*) into c_settings from public.settings               where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
  select count(*) into c_saved    from public.saved_posts            where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
  select count(*) into c_wa       from public.workspace_accounts     where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
  select count(*) into c_voice    from public.voice_profiles         where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
  select count(*) into c_pub      from public.publishing_connections where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
  select count(*) into c_acct     from public.accounts               where manual_owner_workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf';
  raise notice 'LEFT ON OLD ORG (all should be 0): chats=% settings=% saved=% ws_accounts=% voice=% pub_conn=% owned_accounts=%',
    c_chats, c_settings, c_saved, c_wa, c_voice, c_pub, c_acct;
  raise notice 'NEW USER now: chats=% settings=%',
    (select count(*) from public.chats WHERE workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK'),
    (select count(*) from public.settings WHERE workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK');
end $$;

commit;
