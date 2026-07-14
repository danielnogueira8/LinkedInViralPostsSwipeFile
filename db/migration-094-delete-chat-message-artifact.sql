-- Remove every transcript version of a chat artifact atomically.
--
-- In-place Cowork refines reuse the artifact id in a later assistant message
-- so the draft keeps one stable identity. A single-row delete can therefore
-- leave an older version behind, which appears to resurrect after reload.
begin;

create or replace function public.delete_chat_message_artifact(
  p_workspace_id text,
  p_chat_id uuid,
  p_artifact_id text
) returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_removed integer := 0;
begin
  update public.chat_messages as message
  set
    artifacts = (
      select jsonb_agg(item.value order by item.position)
      from jsonb_array_elements(coalesce(message.artifacts, '[]'::jsonb))
        with ordinality as item(value, position)
      where item.value->>'id' is distinct from p_artifact_id
    ),
    artifacts_version = message.artifacts_version + 1
  where message.chat_id = p_chat_id
    and message.workspace_id = p_workspace_id
    and message.role = 'assistant'
    and exists (
      select 1
      from jsonb_array_elements(coalesce(message.artifacts, '[]'::jsonb)) as artifact
      where artifact->>'id' = p_artifact_id
    );

  get diagnostics v_removed = row_count;
  return v_removed;
end;
$$;

revoke execute on function public.delete_chat_message_artifact(
  text, uuid, text
) from public, anon, authenticated;
grant execute on function public.delete_chat_message_artifact(
  text, uuid, text
) to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 94, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
