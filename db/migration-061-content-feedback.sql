-- Migration 061: Content feedback memory
--
-- Stores lightweight user taste signals for generated content. These are not
-- hard writing rules; content_preferences remains the authoritative memory for
-- "always/never" instructions. Feedback rows are raw, reviewable signals that
-- future prompt assembly can summarize in a small bounded block.

create table if not exists content_feedback (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  chat_id uuid,
  -- Cowork artifact ids can be transient client ids; keep this text rather than
  -- forcing a FK. Saved board drafts use draft_id below.
  artifact_id text,
  draft_id uuid,
  rating text not null check (rating in ('up', 'down')),
  reasons text[] not null default '{}',
  note text,
  body_snapshot text not null,
  created_at timestamptz not null default now()
);

create index if not exists content_feedback_workspace_recency_idx
  on content_feedback(workspace_id, created_at desc);

create index if not exists content_feedback_workspace_rating_idx
  on content_feedback(workspace_id, rating, created_at desc);

alter table content_feedback enable row level security;
drop policy if exists content_feedback_isolation on content_feedback;
create policy content_feedback_isolation on content_feedback
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());
