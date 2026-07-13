-- Migration 086: atomic save-to-board command for chat drafts.
-- Serializes identical saves for one workspace/chat/body so concurrent clicks
-- return the same artifact instead of creating duplicate board rows.

alter table chat_artifacts
  add column if not exists lifecycle_version bigint not null default 0;

create or replace function save_chat_draft(
  p_workspace_id text,
  p_chat_id uuid,
  p_kind text,
  p_status text,
  p_title text,
  p_body text,
  p_meta jsonb,
  p_media_attachments jsonb,
  p_saved_by text
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row chat_artifacts%rowtype;
begin
  perform pg_advisory_xact_lock(
    hashtextextended(
      'save-chat-draft:' || p_workspace_id || ':' || p_chat_id::text || ':' || p_body,
      0
    )
  );

  if not exists (
    select 1
    from chats
    where id = p_chat_id
      and workspace_id = p_workspace_id
      and archived_at is null
  ) then
    return jsonb_build_object('outcome', 'chat_not_found');
  end if;

  select * into v_row
  from chat_artifacts
  where workspace_id = p_workspace_id
    and chat_id = p_chat_id
    and body = p_body
  order by created_at desc
  limit 1;

  if found then
    return jsonb_build_object(
      'outcome', 'deduped',
      'draft', to_jsonb(v_row)
    );
  end if;

  insert into chat_artifacts (
    workspace_id,
    chat_id,
    kind,
    status,
    title,
    body,
    meta,
    media_attachments,
    saved_by
  ) values (
    p_workspace_id,
    p_chat_id,
    p_kind,
    p_status,
    p_title,
    p_body,
    p_meta,
    coalesce(p_media_attachments, '[]'::jsonb),
    p_saved_by
  )
  returning * into v_row;

  return jsonb_build_object(
    'outcome', 'saved',
    'draft', to_jsonb(v_row)
  );
end;
$$;

revoke execute on function save_chat_draft(
  text, uuid, text, text, text, text, jsonb, jsonb, text
) from public, anon, authenticated;
grant execute on function save_chat_draft(
  text, uuid, text, text, text, text, jsonb, jsonb, text
) to service_role;
