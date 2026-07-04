-- Creator Styles — reusable, workspace-owned writing-STYLE profiles.
--
-- A creator style profile is distilled from a creator's posts (the ones this
-- workspace already tracks in the swipe file) and captures only WRITING
-- MECHANICS: hook patterns, cadence, sentence length, formatting, paragraph
-- rhythm, common post structures, rhetorical moves, CTA habits. It is applied
-- in Cowork to write ORIGINAL posts in that style — never copying the creator's
-- topics, stories, claims, examples, identity, or exact wording.
--
-- Distinct from content_templates: a template defines ONE post's structure
-- directly; a creator style defines broader writing behavior + formatting
-- preferences reusable across any topic.
--
-- Workspace-shared (workspace_id text = Clerk org id), matching content_templates
-- / custom_skills / voice_profiles. Generation is async (status
-- generating → ready | failed), mirroring voice-profile synthesis.
--
-- IMPORTANT: the distilled profile_json + prompt_block are stored; the FULL post
-- bodies used during analysis are NOT stored here — only distilled style guidance
-- plus source references (creator_style_profile_sources), to avoid holding
-- copied content and to keep rows small.
--
-- Idempotent: create-if-not-exists + drop-then-create policy. Safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. creator_style_profiles — the distilled style guide
-- ---------------------------------------------------------------------------
create table if not exists creator_style_profiles (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  -- User-facing name for the style ("Alex's punchy contrarian style").
  name text not null,
  -- The creator the style was distilled from (display metadata for the card).
  creator_name text,
  creator_handle text,
  creator_avatar_url text,
  -- The tracked account this was generated from, when applicable. NULL when the
  -- style was built from a hand-picked set of saved posts instead. No FK — the
  -- accounts catalog is global/soft-deletable; a dangling id just means the card
  -- shows the stored creator_name without a live link.
  source_account_id uuid,
  -- Optional user note + a system "low sample" warning when <5 posts were found.
  description text,
  -- How many posts the profile was distilled from.
  sample_count int not null default 0,
  -- Async lifecycle: a row is created 'generating', flips to 'ready' when the
  -- model returns a usable profile, or 'failed' with a human message in `error`.
  status text not null default 'generating'
    check (status in ('ready', 'generating', 'failed')),
  -- Human-readable failure reason shown on a failed card (mirrors voice.error).
  error text,
  -- The structured style profile (CreatorStyleProfile in lib/creator-styles.ts):
  -- summary, voice_traits, hook_patterns, structure_patterns, formatting_rules,
  -- rhythm_rules, cta_patterns, post_format_preferences, avoid_copying. NO
  -- copied example bodies live here.
  profile_json jsonb,
  -- The concise, directly-injectable Cowork prompt block distilled from
  -- profile_json (mechanics + anti-copying guardrails).
  prompt_block text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists creator_style_profiles_workspace_idx
  on creator_style_profiles(workspace_id, created_at desc);

-- Partial index for the "is a generation in flight?" / status scans.
create index if not exists creator_style_profiles_status_idx
  on creator_style_profiles(workspace_id, status);

-- ---------------------------------------------------------------------------
-- 2. creator_style_profile_sources — which posts a profile was built from
-- ---------------------------------------------------------------------------
-- Source references (NOT the full bodies), so a user can see what the style was
-- distilled from. workspace_id is denormalized onto the child (like
-- batch_draft_slots) so RLS is a direct auth_workspace_id() check with no join.
create table if not exists creator_style_profile_sources (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references creator_style_profiles(id) on delete cascade,
  workspace_id text not null,
  -- A swipe-file post (posts.id) OR a saved post (saved_posts.id) the style drew
  -- from. Both nullable; at least one is set per row. No FK to keep this a plain
  -- reference resilient to catalog changes.
  post_id uuid,
  saved_post_id uuid,
  -- First line of the source (for a compact "built from" preview in the UI).
  source_first_line text,
  source_url text,
  created_at timestamptz not null default now()
);

create index if not exists creator_style_profile_sources_profile_idx
  on creator_style_profile_sources(profile_id);

-- ---------------------------------------------------------------------------
-- 3. RLS — isolation via auth_workspace_id(), mirroring content_templates
-- ---------------------------------------------------------------------------
alter table creator_style_profiles enable row level security;
drop policy if exists creator_style_profiles_isolation on creator_style_profiles;
create policy creator_style_profiles_isolation on creator_style_profiles
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());

alter table creator_style_profile_sources enable row level security;
drop policy if exists creator_style_profile_sources_isolation on creator_style_profile_sources;
create policy creator_style_profile_sources_isolation on creator_style_profile_sources
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());
