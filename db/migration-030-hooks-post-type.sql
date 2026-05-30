-- Migration 030: Categorize hooks by post type
--
-- The Hook Library used to be a flat list of every viral post's opener,
-- sliced only by pattern_tag. But a lead-magnet opener ("comment X and
-- I'll send it") follows completely different rules than an editorial
-- hook, and they're worth studying separately. We denormalize the post's
-- post_type onto each hook row so the library can filter/group by
-- "Regular" vs "Lead magnet" without re-joining posts at read time and
-- without an extra count query paying for the join.
--
-- post_type mirrors posts.post_type ('regular' | 'lead_magnet'). We default
-- to 'regular' to match posts' own default, then backfill from the parent
-- post for existing rows. Going forward the pipeline stamps it on insert.
--
-- Run order: idempotent. Safe to re-run.

alter table hooks add column if not exists post_type text not null default 'regular';

-- Backfill existing rows from their parent post. Rows whose post is somehow
-- missing keep the 'regular' default.
update hooks h
set post_type = p.post_type
from posts p
where h.post_id = p.id
  and h.post_type is distinct from p.post_type;

create index if not exists hooks_post_type_idx on hooks(post_type);
