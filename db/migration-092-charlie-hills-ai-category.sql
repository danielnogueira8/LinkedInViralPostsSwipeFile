-- Correct Charlie Hills' curated creator category. The case-insensitive handle
-- is the portable stable key and is protected by a unique index.
update public.accounts
set category_id = 'ai',
    niche = 'AI/Tech'
where lower(linkedin_handle) = 'charlie-hills';

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 92, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;
