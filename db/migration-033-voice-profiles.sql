-- Migration 033: Per-workspace voice profile
--
-- The Voice feature scrapes a user's most recent ~50 LinkedIn posts (one
-- Apify run) and asks Claude (Sonnet) to synthesize a structured "voice
-- profile" — who they target, what they talk about, their tone, recurring
-- hooks, do/don'ts, and a few of their own posts as style exemplars. The
-- downstream draft loop reads this profile (via the get_voice MCP tool) so
-- AI-generated content actually sounds like the user.
--
-- One profile per workspace (the workspace IS the user's brand here), so
-- `workspace_id` is unique. The profile is generated once at onboarding and
-- can be regenerated from the Voice tab, subject to a cooldown enforced in
-- the API route using `generated_at`.
--
-- The heavy `profile` payload is jsonb (structured shape defined in the app):
--   { summary, audience{primary,pain_points,outcomes}, topics, positioning,
--     tone, format_patterns{hook_styles,structure,length}, signature_moves,
--     do, dont, exemplars }
-- We keep `summary` as a top-level text column too so list/header views can
-- read it without parsing the json.
--
-- `status` tracks the async generation lifecycle so the tab can render
-- progress: a row is written `pending` immediately (e.g. fire-and-forget from
-- onboarding), flipped to `ready` on success or `failed` (with `error`) on
-- error. This means a row can exist with a null `profile` while pending.
--
-- Run order: idempotent. Safe to re-run.

create table if not exists voice_profiles (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  -- Whose posts we analyzed. handle is the linkedin slug; profile_url is the
  -- full URL the user pasted / we resolved (kept for forensics + display).
  linkedin_handle text,
  profile_url text,
  -- Structured voice profile from the synthesis call. Null while pending or
  -- after a failed run.
  profile jsonb,
  -- Denormalized human-readable brief (also lives inside profile.summary) so
  -- header/list views don't have to parse the json.
  summary text,
  -- How many posts actually fed the synthesis (may be < 50 for creators with
  -- a short history). 0 while pending.
  source_post_count integer not null default 0,
  -- Generation lifecycle: 'pending' | 'ready' | 'failed'.
  status text not null default 'pending',
  -- Failure reason when status = 'failed'; null otherwise.
  error text,
  -- Which model produced the profile (cost/quality auditing). e.g.
  -- 'claude-sonnet-4-6'.
  model text,
  -- When the profile was last successfully generated. Drives the regenerate
  -- cooldown in the API route, and shown in the tab as "last updated". Null
  -- until the first successful run (a pending/failed row has none).
  generated_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id)
);
