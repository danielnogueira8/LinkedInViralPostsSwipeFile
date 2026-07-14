-- Retire the former Google Sheet transport without deleting the shared creator
-- rows it originally populated. Shared creators are now an app-owned catalog.
begin;

alter table public.accounts
  drop constraint if exists accounts_source_check;

update public.accounts
set source = 'catalog'
where source = 'sheet';

alter table public.accounts
  alter column source set default 'catalog';

alter table public.accounts
  add constraint accounts_source_check
  check (source in ('catalog', 'manual'));

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 93, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
