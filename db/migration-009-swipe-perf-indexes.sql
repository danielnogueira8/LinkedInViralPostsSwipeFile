-- Speeds up the /swipe page's main query, which filters on is_viral=true
-- and orders by viral_score / reactions / comments / posted_at.
-- Partial indexes (where is_viral = true) keep them small.

create index if not exists posts_viral_score_idx
  on posts (viral_score desc nulls last)
  where is_viral = true;

create index if not exists posts_viral_reactions_idx
  on posts (reactions desc)
  where is_viral = true;

create index if not exists posts_viral_comments_idx
  on posts (comments desc)
  where is_viral = true;

create index if not exists posts_viral_posted_at_idx
  on posts (posted_at desc nulls last)
  where is_viral = true;

-- For the "Top from last batch" rail (scraped_at >= last_run.started_at, viral=true).
create index if not exists posts_viral_scraped_at_idx
  on posts (scraped_at desc)
  where is_viral = true;

-- For the "latest successful run" lookup on swipe + dashboard.
create index if not exists runs_status_started_at_idx
  on runs (status, started_at desc);

-- For the niche filter chips (accounts.niche IS NOT NULL distinct).
create index if not exists accounts_niche_idx
  on accounts (niche)
  where niche is not null;
