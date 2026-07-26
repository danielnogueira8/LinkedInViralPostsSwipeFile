create role anon;
create role authenticated;
create role service_role;

create table public.app_schema_version (
  singleton boolean primary key,
  version integer not null,
  updated_at timestamptz not null default now()
);
insert into public.app_schema_version (singleton, version)
values (true, 128);
