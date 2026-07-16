create role service_role;

create table public.app_schema_version (
  singleton boolean primary key,
  version integer not null,
  updated_at timestamptz not null default now()
);

insert into public.app_schema_version (singleton, version)
values (true, 97);

create table public.categories (
  id text primary key,
  label text not null,
  description text,
  sort_order integer,
  is_curated boolean not null default false,
  workspace_id text
);

insert into public.categories (
  id, label, description, sort_order, is_curated, workspace_id
)
values (
  'outreach',
  'Sales/Outreach',
  'Prospecting, pipeline, and modern sales.',
  40,
  true,
  null
);

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  profile_url text not null,
  linkedin_handle text not null,
  niche text,
  category_id text references public.categories(id),
  headline text,
  recommendation_reason text,
  discovery_tags text[] not null default '{}',
  is_featured boolean not null default false,
  source text not null,
  manual_owner_workspace_id text,
  archived_at timestamptz,
  synced_at timestamptz
);

create unique index accounts_linkedin_handle_ci_unique
  on public.accounts (lower(linkedin_handle));

insert into public.accounts (
  name,
  profile_url,
  linkedin_handle,
  niche,
  category_id,
  source,
  manual_owner_workspace_id,
  archived_at
)
values
  (
    'Existing outreach creator',
    'https://www.linkedin.com/in/existing-outreach/',
    'existing-outreach',
    'Sales/Outreach',
    'outreach',
    'sheet',
    null,
    null
  ),
  (
    'Stale manual copy',
    'https://www.linkedin.com/in/divyanshis-saasleadgen',
    'Divyanshis-SaaSLeadGen',
    'Other',
    null,
    'manual',
    'ws-1',
    now()
  );

create table public.workspace_accounts (
  workspace_id text not null,
  account_id uuid not null references public.accounts(id),
  niche text,
  category_id text references public.categories(id),
  primary key (workspace_id, account_id)
);

insert into public.workspace_accounts (
  workspace_id, account_id, niche, category_id
)
select 'ws-1', id, 'Sales/Outreach', 'outreach'
from public.accounts
where linkedin_handle = 'existing-outreach';
