-- Migration 073: Persist assistant tool-call turns atomically and in protocol order.

create or replace function persist_chat_assistant_turn(
  p_chat_id uuid,
  p_workspace_id text,
  p_content text,
  p_tool_calls jsonb,
  p_artifacts jsonb,
  p_input_tokens integer,
  p_output_tokens integer,
  p_tool_messages jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_assistant_id uuid;
  v_base_time timestamptz := clock_timestamp();
  v_tool jsonb;
  v_ordinal bigint;
begin
  if not exists (
    select 1
    from chats
    where id = p_chat_id
      and workspace_id = p_workspace_id
  ) then
    raise exception 'Chat not found';
  end if;

  insert into chat_messages (
    chat_id,
    workspace_id,
    role,
    content,
    tool_calls,
    artifacts,
    input_tokens,
    output_tokens,
    created_at
  )
  values (
    p_chat_id,
    p_workspace_id,
    'assistant',
    coalesce(p_content, ''),
    p_tool_calls,
    p_artifacts,
    p_input_tokens,
    p_output_tokens,
    v_base_time
  )
  returning id into v_assistant_id;

  for v_tool, v_ordinal in
    select value, ordinality
    from jsonb_array_elements(coalesce(p_tool_messages, '[]'::jsonb))
      with ordinality
  loop
    insert into chat_messages (
      chat_id,
      workspace_id,
      role,
      content,
      tool_call_id,
      created_at
    )
    values (
      p_chat_id,
      p_workspace_id,
      'tool',
      coalesce(v_tool->>'content', ''),
      v_tool->>'tool_call_id',
      v_base_time + (v_ordinal * interval '1 microsecond')
    );
  end loop;

  return v_assistant_id;
end;
$$;

revoke all on function persist_chat_assistant_turn(
  uuid, text, text, jsonb, jsonb, integer, integer, jsonb
) from public;
revoke all on function persist_chat_assistant_turn(
  uuid, text, text, jsonb, jsonb, integer, integer, jsonb
) from anon;
revoke all on function persist_chat_assistant_turn(
  uuid, text, text, jsonb, jsonb, integer, integer, jsonb
) from authenticated;
grant execute on function persist_chat_assistant_turn(
  uuid, text, text, jsonb, jsonb, integer, integer, jsonb
) to service_role;
