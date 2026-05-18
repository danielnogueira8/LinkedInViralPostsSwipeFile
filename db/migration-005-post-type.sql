-- Classify posts as 'lead_magnet' vs 'regular' so the swipe file and
-- templates page can be filtered by intent. Classification runs in the
-- pipeline; this migration just adds the columns and backfills nulls.

alter table posts add column if not exists post_type text not null default 'regular';
alter table posts add column if not exists post_type_detected_via text;

create index if not exists posts_post_type_idx on posts(post_type);
