-- Migration 014: Hook library
--
-- Stores the first 1-2 sentences of every viral post as a "hook" so users
-- can browse openers across the swipe file in isolation. Hooks are
-- extracted by a paragraph-break heuristic during the daily pipeline; if
-- the heuristic produces something unusable (>400 chars, ends mid-word,
-- empty), Claude Haiku is called as fallback. Pattern is tagged in the
-- same Claude call when fallback fires; heuristic-only rows get pattern
-- backfilled lazily when shown.
--
-- One hook row per post (unique post_id).
--
-- Run order: idempotent. Safe to re-run.

create table if not exists hooks (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null unique references posts(id) on delete cascade,
  hook_text text not null,
  pattern_tag text,
  extracted_via text not null default 'heuristic' check (extracted_via in ('heuristic', 'claude')),
  generated_at timestamptz not null default now()
);

create index if not exists hooks_post_idx on hooks(post_id);
create index if not exists hooks_pattern_idx on hooks(pattern_tag);
