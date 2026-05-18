-- Adds creator avatar + headline to accounts. Populated on each scrape from
-- Apify's author.profile_picture / author.headline fields.

alter table accounts
  add column if not exists profile_pic_url text,
  add column if not exists headline text;
