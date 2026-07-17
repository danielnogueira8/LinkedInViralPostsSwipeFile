-- Migration 105: atomic dedup for standalone (chat_id is null) drafts.
--
-- DraftLifecycle.create() (used by the create_draft MCP tool and the
-- POST /api/drafts "New post" button) was a plain unconditional INSERT — a
-- retried MCP call (timeout, network blip, an LLM calling the tool twice)
-- created two identical drafts instead of one. save_chat_draft (migration
-- 086) already solved this for chat-saved drafts, but its dedup key is
-- (workspace_id, chat_id, body) — meaningless here, since these drafts have
-- no chat by design (MCP has no concept of this app's chats; "New post" is
-- authored directly on the board).
--
-- Mirrors save_chat_draft's shape: an advisory lock serializes concurrent
-- identical creates, then a recency-windowed check-then-insert. The window
-- (not "ever") means a genuinely new draft with coincidentally identical
-- text to something created weeks ago still gets its own row — this guards
-- against RETRIES, not against the user intentionally duplicating content.

create or replace function save_standalone_draft(
  p_workspace_id text,
  p_kind text,
  p_status text,
  p_title text,
  p_body text,
  p_meta jsonb,
  p_media_attachments jsonb,
  p_plan_to_post_on date,
  p_dedup_window_seconds integer default 300
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row chat_artifacts%rowtype;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('save-standalone-draft:' || p_workspace_id || ':' || p_body, 0)
  );

  select * into v_row
  from chat_artifacts
  where workspace_id = p_workspace_id
    and chat_id is null
    and body = p_body
    and created_at >= now() - make_interval(secs => p_dedup_window_seconds)
  order by created_at desc
  limit 1;

  if found then
    return jsonb_build_object('outcome', 'deduped', 'draft', to_jsonb(v_row));
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
    plan_to_post_on
  ) values (
    p_workspace_id,
    null,
    p_kind,
    p_status,
    p_title,
    p_body,
    p_meta,
    coalesce(p_media_attachments, '[]'::jsonb),
    p_plan_to_post_on
  )
  returning * into v_row;

  return jsonb_build_object('outcome', 'saved', 'draft', to_jsonb(v_row));
end;
$$;

revoke execute on function save_standalone_draft(
  text, text, text, text, text, jsonb, jsonb, date, integer
) from public, anon, authenticated;
grant execute on function save_standalone_draft(
  text, text, text, text, text, jsonb, jsonb, date, integer
) to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 105, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;
