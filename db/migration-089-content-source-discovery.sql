-- Migration 089: normalize the global creator catalog and add discovery metadata.
-- Global baseline creators are app-owned rows. A workspace owns only its
-- workspace_accounts membership, never the shared recommendation record.

begin;

alter table accounts
  add column if not exists recommendation_reason text,
  add column if not exists discovery_tags text[] not null default '{}',
  add column if not exists is_featured boolean not null default false;

insert into categories (id, label, description, sort_order, is_curated, workspace_id) values
  ('linkedin-content',  'LinkedIn & Personal Brand', 'Writing, positioning, and audience growth on LinkedIn.', 10, true, null),
  ('ai',                'AI & Technology', 'Applied AI, software, and emerging technology.', 20, true, null),
  ('automation',        'Automation & No-Code', 'Systems, workflows, and no-code operations.', 30, true, null),
  ('outreach',          'Sales & Outreach', 'Prospecting, pipeline, and modern sales.', 40, true, null),
  ('gtm',               'Marketing & Growth', 'Go-to-market strategy, distribution, and growth.', 50, true, null),
  ('ads',               'Paid Ads & Creative', 'Performance marketing, creative strategy, and media buying.', 60, true, null),
  ('seo',               'SEO & Organic Growth', 'Search, content strategy, and organic acquisition.', 70, true, null),
  ('agency-operations', 'Agency & Services', 'Building and operating client-service businesses.', 80, true, null),
  ('investor',          'Investing & Fundraising', 'Venture, capital, and fundraising.', 90, true, null),
  ('founders-startups', 'Founders & Startups', 'Founder stories, startup building, and entrepreneurship.', 100, true, null),
  ('creator-economy',   'Creator Economy & UGC', 'Creators, partnerships, community, and user-generated content.', 110, true, null)
on conflict (id) do update set
  label = excluded.label,
  description = excluded.description,
  sort_order = excluded.sort_order,
  is_curated = true,
  workspace_id = null;

-- Keep the legacy niche mirror readable for integrations that still expose it.
update accounts a
set niche = c.label
from categories c
where a.category_id = c.id
  and c.workspace_id is null
  and a.niche is distinct from c.label;

-- Normalize exact handle keys before merging collisions.
update accounts
set linkedin_handle = lower(trim(both '@' from trim(linkedin_handle)))
where linkedin_handle is distinct from lower(trim(both '@' from trim(linkedin_handle)));

-- Merge exact-handle duplicates into one canonical row. Prefer an existing
-- app-owned sheet row, then the oldest stable UUID. Preserve posts and every
-- workspace membership before deleting the losing account.
create temporary table account_handle_merges on commit drop as
with ranked as (
  select
    id,
    first_value(id) over (
      partition by lower(linkedin_handle)
      order by
        case when source = 'sheet' and manual_owner_workspace_id is null then 0 else 1 end,
        id
    ) as winner_id,
    row_number() over (
      partition by lower(linkedin_handle)
      order by
        case when source = 'sheet' and manual_owner_workspace_id is null then 0 else 1 end,
        id
    ) as position
  from accounts
  where nullif(trim(linkedin_handle), '') is not null
)
select id as loser_id, winner_id
from ranked
where position > 1;

insert into workspace_accounts (workspace_id, account_id, niche, category_id, added_at)
select wa.workspace_id, m.winner_id, wa.niche, wa.category_id, wa.added_at
from workspace_accounts wa
join account_handle_merges m on m.loser_id = wa.account_id
on conflict (workspace_id, account_id) do update set
  niche = coalesce(workspace_accounts.niche, excluded.niche),
  category_id = coalesce(workspace_accounts.category_id, excluded.category_id),
  added_at = least(workspace_accounts.added_at, excluded.added_at);

delete from workspace_accounts wa
using account_handle_merges m
where wa.account_id = m.loser_id;

update posts p
set account_id = m.winner_id
from account_handle_merges m
where p.account_id = m.loser_id;

update accounts
set total_post_count = 0, viral_post_count = 0
where id in (select distinct winner_id from account_handle_merges);

update accounts a
set
  total_post_count = totals.total_count,
  viral_post_count = totals.viral_count
from (
  select
    p.account_id,
    count(*)::int as total_count,
    count(*) filter (where p.is_viral)::int as viral_count
  from posts p
  where p.account_id in (select distinct winner_id from account_handle_merges)
  group by p.account_id
) totals
where a.id = totals.account_id;

delete from accounts a
using account_handle_merges m
where a.id = m.loser_id;

-- Approved baseline creators discovered from the signed-in LinkedIn feed.
-- Update by normalized handle first so an existing manual copy is promoted to
-- the shared catalog instead of creating another account.
create temporary table baseline_creators (
  name text,
  linkedin_handle text,
  category_id text,
  headline text,
  recommendation_reason text,
  discovery_tags text[]
) on commit drop;

insert into baseline_creators values
  ('Magali De Reu', 'magalidereu', 'linkedin-content', 'B2B storytelling and personal-brand strategy', 'Strong examples of turning expertise into memorable LinkedIn stories.', array['linkedin','personal brand','storytelling']),
  ('Grace Andrews', 'grace-andrews1', 'creator-economy', 'Creator brand and community strategy', 'Practical lessons from building modern creator-led brands.', array['creator economy','community','personal brand']),
  ('Vedika Bhaia', 'vedikabhaia', 'linkedin-content', 'Personal branding and LinkedIn growth', 'Clear, repeatable advice for becoming more visible on LinkedIn.', array['linkedin','personal brand','audience growth']),
  ('Raza Abdullah', 'razaabdullah', 'linkedin-content', 'LinkedIn writing and positioning', 'Useful examples of concise educational LinkedIn content.', array['linkedin','writing','positioning']),
  ('João Ferrão dos Santos', 'joao-ferrao-dos-santos', 'linkedin-content', 'Founder-led personal branding', 'Distinctive creative formats for founder and personal-brand content.', array['linkedin','personal brand','creative']),
  ('Aisha Riaz', 'aishariazs', 'linkedin-content', 'LinkedIn content and audience building', 'Accessible content lessons for newer LinkedIn creators.', array['linkedin','content strategy','audience growth']),
  ('Shradha Khapra', 'shradha-khapra', 'ai', 'Technology educator and founder', 'Makes technical and AI topics understandable to a broad audience.', array['ai','technology','education']),
  ('Edward Deng', 'edward-deng-bb502a386', 'ads', 'Performance creative and paid growth', 'Concrete examples of creative strategy tied to acquisition.', array['paid ads','creative strategy','growth']),
  ('Hans Dekker', 'itshansdekker', 'gtm', 'B2B marketing and demand generation', 'Operator-level marketing systems and distribution lessons.', array['b2b marketing','demand generation','growth']),
  ('Elena Verna', 'elenaverna', 'gtm', 'Product-led growth and retention', 'High-signal frameworks for sustainable product and revenue growth.', array['product-led growth','retention','growth']),
  ('Justin Rowe', 'justin-rowe-4043339b', 'gtm', 'B2B growth and LinkedIn distribution', 'Strong examples of combining content with measurable pipeline growth.', array['b2b marketing','linkedin','growth']),
  ('Tristan Gillen', 'tristangillen', 'gtm', 'Startup marketing and content strategy', 'Tactical startup-distribution ideas with clear takeaways.', array['startup marketing','content strategy','growth']),
  ('Cameron Poole', 'trajectory-sales', 'outreach', 'Outbound sales systems', 'Practical advice for building repeatable outbound pipeline.', array['sales','outreach','pipeline']),
  ('Olga Kirillova', 'olga-kirillova', 'outreach', 'B2B sales and go-to-market', 'Useful examples of sales education and commercial positioning.', array['sales','gtm','positioning']),
  ('Bruno Morris', 'brunomorris', 'gtm', 'Growth marketing and content', 'Clear breakdowns of growth and distribution tactics.', array['marketing','content strategy','growth']),
  ('Talal Abulshamat', 'talalabulshamat', 'ads', 'Creative strategy and advertising', 'Strong paid-social and creative-strategy examples.', array['paid ads','creative strategy','social']),
  ('Bram Vermolen', 'bram-vermolen-05669825', 'agency-operations', 'Organic growth for eCommerce brands', 'A current feed voice on operating a specialist growth service for eCommerce brands.', array['agency','ecommerce','organic growth']),
  ('Marceline Danielle T.', 'marceline-danielle-t-a6b195295', 'automation', 'AI agents for sales workflows', 'A current feed voice showing concrete ways AI agents automate prospecting and follow-up.', array['automation','ai agents','sales workflows']),
  ('Audrey Chia', 'audrey-chia', 'gtm', 'Positioning, strategy, and human-AI workflows', 'Strong brand-positioning and conversion copy examples with an applied AI angle.', array['positioning','copywriting','ai workflows']),
  ('Eugenio Zabell', 'eugenio-zabell', 'creator-economy', 'UGC and creator partnerships', 'Practical creator-economy and UGC operating advice.', array['ugc','creator economy','partnerships']),
  ('Shubham Davey', 'bydaveyji', 'seo', 'SEO and organic acquisition', 'Actionable organic-growth lessons for marketers and founders.', array['seo','organic growth','content']),
  ('Pia Vosloo', 'pia-vosloo', 'seo', 'SEO and content strategy', 'Clear search and content frameworks for sustainable acquisition.', array['seo','content strategy','organic growth']),
  ('Prasad Karthik', 'prasadkarthikcommunicator', 'seo', 'Content-led organic growth', 'Useful examples of educational content built for discoverability.', array['seo','content','communication']),
  ('Rick Post', 'rick-post', 'seo', 'SEO and digital growth', 'Practical search-led growth ideas for operators.', array['seo','digital marketing','growth']),
  ('Raj Shamani', 'rajshamani', 'founders-startups', 'Entrepreneur and business storyteller', 'High-reach founder stories and business lessons with broad appeal.', array['founders','entrepreneurship','storytelling']),
  ('Aman Gupta', 'aman-gupta-7217a515', 'founders-startups', 'Founder and consumer-brand operator', 'Founder-led brand building and entrepreneurship examples.', array['founders','consumer brand','entrepreneurship']),
  ('Seb Johnson', 'seb-johnson', 'founders-startups', 'Startup founder and operator', 'Operator-focused startup lessons for early-stage builders.', array['founders','startups','operations']),
  ('Harry Stebbings', 'harrystebbings', 'investor', 'Venture investor and interviewer', 'High-signal founder, fundraising, and venture-market insights.', array['venture','fundraising','founders']);

update accounts a
set
  name = b.name,
  profile_url = 'https://www.linkedin.com/in/' || b.linkedin_handle,
  linkedin_handle = b.linkedin_handle,
  niche = c.label,
  category_id = b.category_id,
  headline = b.headline,
  recommendation_reason = b.recommendation_reason,
  discovery_tags = b.discovery_tags,
  is_featured = true,
  source = 'sheet',
  manual_owner_workspace_id = null,
  archived_at = null
from baseline_creators b
join categories c on c.id = b.category_id
where lower(a.linkedin_handle) = b.linkedin_handle;

insert into accounts (
  name, profile_url, linkedin_handle, niche, category_id, headline,
  recommendation_reason, discovery_tags, is_featured, source,
  manual_owner_workspace_id, synced_at
)
select
  b.name,
  'https://www.linkedin.com/in/' || b.linkedin_handle,
  b.linkedin_handle,
  c.label,
  b.category_id,
  b.headline,
  b.recommendation_reason,
  b.discovery_tags,
  true,
  'sheet',
  null,
  now()
from baseline_creators b
join categories c on c.id = b.category_id
where not exists (
  select 1 from accounts a where lower(a.linkedin_handle) = b.linkedin_handle
);

-- High-confidence catalog corrections from the audit. Ambiguous rows stay as-is.
update accounts set category_id = 'gtm' where lower(linkedin_handle) in ('arielcohen-aigrowth','nicolas-olaya-zuluaga');
update accounts set category_id = 'investor' where lower(linkedin_handle) = 'ignacio-prma';
update accounts set category_id = 'founders-startups' where lower(linkedin_handle) in ('tomas-jones1','robbieferguson');
update accounts set category_id = 'outreach' where lower(linkedin_handle) in ('jack-c-6011801a5','joonhyeok-ahn');
update accounts set category_id = 'ads' where lower(linkedin_handle) = 'jessepujji';
update accounts set category_id = 'linkedin-content' where lower(linkedin_handle) = 'danielpaulai';
update accounts set category_id = 'outreach' where lower(linkedin_handle) = 'rom%c3%a0n-czerny-11b773199';
update accounts set name = 'Jonathan Peslar', category_id = 'outreach' where lower(linkedin_handle) = 'jonathan-peslar';
update accounts set name = 'Finlay Topping', category_id = 'outreach' where lower(linkedin_handle) = 'finley-topping-570b1a300';
update accounts set name = 'Nicolas Cole' where lower(linkedin_handle) = 'nicolascole';
update accounts set name = 'Nicholas Mihailou' where lower(linkedin_handle) = 'nicholas-mihailou';
update accounts set name = 'Omer Duzkale' where lower(linkedin_handle) = 'omer-duzkale-a841a436a';

-- Re-sync niche labels after targeted category changes.
update accounts a
set niche = c.label
from categories c
where a.category_id = c.id
  and c.workspace_id is null
  and a.niche is distinct from c.label;

-- Explain every shared recommendation, including the existing catalog. The
-- hand-curated baseline copy above wins; legacy rows receive a concise topic-
-- based fallback instead of rendering an unexplained blank card.
update accounts a
set
  recommendation_reason = coalesce(
    nullif(trim(a.recommendation_reason), ''),
    'A proven voice in ' || c.label || ' with posts already available to study.'
  ),
  discovery_tags = case
    when cardinality(a.discovery_tags) = 0 then array[lower(c.label)]
    else a.discovery_tags
  end
from categories c
where a.category_id = c.id
  and c.workspace_id is null
  and a.source <> 'manual'
  and a.manual_owner_workspace_id is null;

-- Uncategorized legacy rows are still part of the shared Explore catalog, so
-- give them a useful generic explanation instead of leaving an empty card.
update accounts a
set
  recommendation_reason = coalesce(
    nullif(trim(a.recommendation_reason), ''),
    'A proven creator with posts already available to study.'
  ),
  discovery_tags = case
    when cardinality(a.discovery_tags) = 0 then array['creator']
    else a.discovery_tags
  end
where a.source <> 'manual'
  and a.manual_owner_workspace_id is null
  and (
    nullif(trim(a.recommendation_reason), '') is null
    or cardinality(a.discovery_tags) = 0
  );

create unique index if not exists accounts_linkedin_handle_ci_unique
  on accounts (lower(linkedin_handle));

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 89, now())
on conflict (singleton) do update set version = excluded.version, updated_at = excluded.updated_at;

commit;
