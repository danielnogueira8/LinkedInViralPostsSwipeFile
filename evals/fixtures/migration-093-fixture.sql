create table public.app_schema_version (
  singleton boolean primary key default true check (singleton),
  version integer not null,
  updated_at timestamptz not null default now()
);

insert into public.app_schema_version (singleton, version) values (true, 92);

create table public.accounts (
  id text primary key,
  name text not null,
  source text not null default 'sheet' check (source in ('sheet', 'manual'))
);

insert into public.accounts (id, name, source) values
  ('catalog-1', 'Catalog One', 'sheet'),
  ('catalog-2', 'Catalog Two', 'sheet'),
  ('manual-1', 'Manual One', 'manual');
