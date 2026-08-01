-- Migration 167: make agent opportunity drafting and system-chat creation
-- single-writer operations.
--
-- Two browser clicks can otherwise both observe a proposed opportunity and
-- both create the lazily-created "Your agent" chat. The application now uses
-- status-qualified updates for the opportunity claim; this unique partial
-- index gives the chat get-or-create path the same database-level guarantee.

begin;

-- Preserve transcripts while making the reserved system-chat title unique for
-- active chats. Duplicates can only be historical races or manually-created
-- copies of the reserved title; keep the oldest as the canonical chat.
with ranked as (
  select
    id,
    row_number() over (
      partition by workspace_id
      order by created_at asc, id asc
    ) as row_number
  from public.chats
  where title = 'Your agent'
    and archived_at is null
)
update public.chats chat
set archived_at = now(),
    updated_at = now()
from ranked
where chat.id = ranked.id
  and ranked.row_number > 1;

create unique index if not exists chats_agent_system_live_idx
  on public.chats (workspace_id)
  where title = 'Your agent'
    and archived_at is null;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 167, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
