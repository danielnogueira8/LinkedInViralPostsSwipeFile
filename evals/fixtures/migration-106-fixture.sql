create role service_role;
create role anon;
create role authenticated;

create domain public.vector as text;

create table public.app_schema_version (
  singleton boolean primary key,
  version integer not null,
  updated_at timestamptz not null default now()
);

insert into public.app_schema_version (singleton, version)
values (true, 105);

create table public.settings (
  workspace_id text not null,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, key)
);
