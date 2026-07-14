-- Compact the curated category labels, merge the workspace's duplicate UGC
-- bucket into the canonical short-form bucket, and correct Bram Vermolen's
-- category. The canonical category ids stay stable so saved filters and URLs
-- continue to work.

-- Merge the workspace-private "UGC" category into the existing curated
-- creator-economy category before renaming it. Repoint every category FK first
-- so deleting the duplicate cannot orphan creator or bookmark data.
update accounts
set category_id = 'creator-economy',
    niche = 'Short-form content & UGC'
where category_id = 'e8628bed-0f09-46d3-9f4d-37ea76303d42';

update workspace_accounts
set category_id = 'creator-economy'
where category_id = 'e8628bed-0f09-46d3-9f4d-37ea76303d42';

update saved_posts
set category_id = 'creator-economy'
where category_id = 'e8628bed-0f09-46d3-9f4d-37ea76303d42';

update saved_post_overrides
set category_id = 'creator-economy'
where category_id = 'e8628bed-0f09-46d3-9f4d-37ea76303d42';

delete from categories
where id = 'e8628bed-0f09-46d3-9f4d-37ea76303d42'
  and workspace_id = 'org_3Dze788MkPVkhrlpWHh88NG8Wiv';

update categories
set label = case id
  when 'linkedin-content' then 'LinkedIn/Personal Brand'
  when 'ai' then 'AI/Tech'
  when 'automation' then 'Automation/No-code'
  when 'outreach' then 'Sales/Outreach'
  when 'gtm' then 'Marketing/Growth'
  when 'ads' then 'Paid Ads/Creative'
  when 'seo' then 'SEO/Organic'
  when 'agency-operations' then 'Agency/Services'
  when 'investor' then 'Investing/Fundraising'
  when 'founders-startups' then 'Founders/Startups'
  when 'creator-economy' then 'Short-form content & UGC'
  else label
end
where workspace_id is null;

-- Keep the legacy niche mirror aligned with the category label. Several agent
-- and export paths still expose this field even though category_id is primary.
update accounts a
set niche = c.label
from categories c
where a.category_id = c.id
  and c.workspace_id is null;

update accounts
set category_id = 'seo', niche = 'SEO/Organic'
where lower(name) = 'bram vermolen';

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 90, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;
