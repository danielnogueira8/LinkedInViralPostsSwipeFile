-- Migration 111: session-sticky Cowork lane pinning per chat.
-- Once a chat routes to a non-answer lane, that lane is persisted so the next
-- ambiguous turn stays in the same drafting workflow instead of falling back to
-- the answer lane.

alter table public.chats
  add column if not exists pinned_cowork_route text;

alter table public.chats
  drop constraint if exists chats_pinned_cowork_route_check;

alter table public.chats
  add constraint chats_pinned_cowork_route_check
  check (
    pinned_cowork_route is null
    or pinned_cowork_route in (
      'direct_writer',
      'action_orchestrator',
      'read_only_orchestrator',
      'answer'
    )
  );

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 111, now())
on conflict (singleton)
do update set version = 111, updated_at = now();
