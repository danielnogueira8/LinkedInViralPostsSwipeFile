-- Persist assistant prose format per message so a later model switch cannot
-- reinterpret historical chat content. Existing messages have no trustworthy
-- per-row model provenance, so they keep the previous app-wide behavior through
-- an explicit legacy state. Every new app write supplies plain or markdown.

begin;

alter table public.chat_messages
  add column if not exists content_format text not null default 'legacy';

alter table public.chat_messages
  drop constraint if exists chat_messages_content_format_check;
alter table public.chat_messages
  add constraint chat_messages_content_format_check
  check (content_format in ('legacy', 'plain', 'markdown'));

-- Rolling-deploy-safe overload: the nine-argument persistence function remains
-- available to the previous app version. The new function calls it and stamps
-- the inserted assistant row in the same transaction.
create or replace function public.persist_chat_assistant_turn(
  p_chat_id uuid,
  p_workspace_id text,
  p_content text,
  p_tool_calls jsonb,
  p_artifacts jsonb,
  p_input_tokens integer,
  p_output_tokens integer,
  p_tool_messages jsonb,
  p_terminal_reason text,
  p_content_format text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_assistant_id uuid;
begin
  if p_content_format not in ('plain', 'markdown') then
    raise exception 'invalid assistant content format';
  end if;

  v_assistant_id := public.persist_chat_assistant_turn(
    p_chat_id,
    p_workspace_id,
    p_content,
    p_tool_calls,
    p_artifacts,
    p_input_tokens,
    p_output_tokens,
    p_tool_messages,
    p_terminal_reason
  );

  update public.chat_messages as message
  set content_format = p_content_format
  where message.id = v_assistant_id
    and message.chat_id = p_chat_id
    and message.workspace_id = p_workspace_id
    and message.role = 'assistant';

  return v_assistant_id;
end;
$$;

revoke all on function public.persist_chat_assistant_turn(
  uuid, text, text, jsonb, jsonb, integer, integer, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.persist_chat_assistant_turn(
  uuid, text, text, jsonb, jsonb, integer, integer, jsonb, text, text
) to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 97, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
