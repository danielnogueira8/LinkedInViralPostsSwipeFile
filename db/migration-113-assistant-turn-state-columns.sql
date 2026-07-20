-- Migration 113: Persist assistant turn-state columns alongside tool_calls markers.
-- Phase 3 of the Cowork unification refactor (dual-write step).

begin;

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
  p_content_format text,
  p_recoverable_error jsonb,
  p_turn_usage jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_assistant_id uuid;
begin
  v_assistant_id := public.persist_chat_assistant_turn(
    p_chat_id,
    p_workspace_id,
    p_content,
    p_tool_calls,
    p_artifacts,
    p_input_tokens,
    p_output_tokens,
    p_tool_messages,
    p_terminal_reason,
    p_content_format
  );

  update public.chat_messages as message
  set
    recoverable_error = p_recoverable_error,
    turn_usage = p_turn_usage
  where message.id = v_assistant_id
    and message.chat_id = p_chat_id
    and message.workspace_id = p_workspace_id
    and message.role = 'assistant';

  return v_assistant_id;
end;
$$;

revoke all on function public.persist_chat_assistant_turn(
  uuid, text, text, jsonb, jsonb, integer, integer, jsonb, text, text, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.persist_chat_assistant_turn(
  uuid, text, text, jsonb, jsonb, integer, integer, jsonb, text, text, jsonb, jsonb
) to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 113, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
