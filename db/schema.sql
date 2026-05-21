-- LinkedIn Viral Posts Swipe File schema
-- Run this in Supabase SQL editor

create extension if not exists "pgcrypto";

create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  profile_url text not null unique,
  linkedin_handle text not null,
  niche text,
  profile_pic_url text,
  headline text,
  source text not null default 'sheet' check (source in ('sheet', 'manual')),
  synced_at timestamptz not null default now()
);

create index if not exists accounts_source_idx on accounts(source);

create table if not exists posts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  linkedin_post_id text not null unique,
  post_url text,
  posted_at timestamptz,
  scraped_at timestamptz not null default now(),
  text text,
  reactions int not null default 0,
  comments int not null default 0,
  reposts int not null default 0,
  media_type text not null default 'none',
  media_urls jsonb not null default '[]'::jsonb,
  visual_kind text,
  is_viral boolean not null default false,
  viral_score numeric,
  post_type text not null default 'regular',
  post_type_detected_via text
);

create index if not exists posts_account_idx on posts(account_id);
create index if not exists posts_viral_idx on posts(is_viral) where is_viral = true;
create index if not exists posts_posted_at_idx on posts(posted_at desc);
create index if not exists posts_post_type_idx on posts(post_type);

create table if not exists templates (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null unique references posts(id) on delete cascade,
  template_text text not null,
  structure jsonb,
  model text,
  generated_at timestamptz not null default now()
);

create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  brand_colors jsonb not null default '[]'::jsonb,
  notes text,
  logo_url text,
  font_primary text,
  font_secondary text,
  created_at timestamptz not null default now()
);

create table if not exists image_prompts (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references posts(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  prompt_text text not null,
  generated_at timestamptz not null default now(),
  unique (post_id, client_id)
);

create table if not exists runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running',
  accounts_count int,
  posts_count int,
  viral_count int,
  apify_run_id text,
  error text
);

create table if not exists settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

insert into settings (key, value) values
  ('viral_thresholds', '{"min_reactions": 200, "min_comments": 50}'::jsonb),
  ('template_thresholds', '{"min_reactions": 500, "min_comments": 100}'::jsonb)
on conflict (key) do nothing;
