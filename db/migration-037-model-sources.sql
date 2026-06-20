-- Migration 037: Model-source handoff for "Model this post"
--
-- When a user clicks "Model this post" on the swipe file or a bookmark, we stash
-- the post (full text + author + provenance) in a short-lived row and navigate
-- to the chat with ?model=<id>. The chat fetches it, shows it as a source-post
-- chip above the composer, and weaves the full text into the modeling prompt.
--
-- Why a server-side stash instead of a URL param: a viral LinkedIn post can run
-- well past safe URL length, and those long posts are exactly the ones users
-- most want to model. Passing an id keeps the handoff robust for any length and
-- preserves the full text + author cleanly for the chip.
--
-- These rows are a transient clipboard, not durable content — safe to prune
-- aggressively (a cleanup pass can delete anything older than a day).
--
-- Multi-tenancy mirrors migration 011 / 016 / 036: workspace_id = Clerk org_id,
-- RLS on, isolation via auth_workspace_id().
--
-- Idempotent and safe to re-run.

create table if not exists chat_modeling_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  -- The post to model after.
  post_text text not null,
  author_name text,
  author_avatar text,
  -- Provenance, so the chip and the prompt can say where it came from.
  source text not null check (source in ('swipe', 'bookmark')),
  -- The originating post/bookmark id (swipe posts.id or saved_posts.id), for
  -- forensics and possible dedupe. Free-form text (uuid in practice).
  source_post_id text,
  -- True when we could only carry a partial (oEmbed snippet) because the full
  -- embed scrape failed — surfaced in the chip so the user knows the source is
  -- incomplete.
  partial boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists chat_modeling_sources_workspace_idx
  on chat_modeling_sources(workspace_id, created_at desc);

alter table chat_modeling_sources enable row level security;
drop policy if exists chat_modeling_sources_isolation on chat_modeling_sources;
create policy chat_modeling_sources_isolation on chat_modeling_sources
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());
