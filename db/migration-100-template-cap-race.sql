-- Migration 100: Atomic per-workspace content-template creation (close the
-- count-then-insert TOCTOU race)
--
-- createTemplateResource (lib/content-resource-operations.ts) enforced the
-- 100-template-per-workspace cap as two separate round trips: a SELECT count,
-- then (if under the limit) an INSERT. Two concurrent creates can both read a
-- below-cap count before either insert lands, so both proceed — the cap can
-- be exceeded by however many requests race inside that window (bulk imports,
-- double-clicks, or a script hammering the endpoint).
--
-- Fix, same pattern as claim_chat_turn (migration 038/042) and
-- claim_ai_operation: a single RPC that takes a per-workspace advisory lock,
-- counts, and inserts INSIDE the same transaction/lock, so a racing caller
-- either sees the row that just landed (and correctly hits the cap) or is
-- still waiting on the lock. No app-level TOCTOU window is possible.
--
-- Scope: content_templates only (this migration's target). The identical
-- count-then-insert shape also exists for categories (CUSTOM_CATEGORY_LIMIT)
-- and custom_skills (SKILLS_PER_WORKSPACE_MAX) in the same file — tracked as
-- separate follow-up fixes, not bundled here.
--
-- Run order: idempotent (create or replace). Safe to re-run.

create or replace function claim_content_template_slot(
  p_workspace_id text,
  p_max_templates int,
  p_title text,
  p_category text,
  p_body text,
  p_source text,
  p_origin_post_id uuid
)
returns table (
  id uuid,
  workspace_id text,
  title text,
  category text,
  body text,
  source text,
  origin_post_id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  over_cap boolean
)
language plpgsql
as $$
declare
  v_count int;
  v_row content_templates%rowtype;
begin
  -- Serialize concurrent creates for this workspace. hashtext() maps the
  -- workspace id to a lock key; the lock auto-releases at transaction end,
  -- so a racing caller blocks here until this one commits or rolls back.
  perform pg_advisory_xact_lock(hashtext('content_template_slot:' || p_workspace_id));

  select count(*) into v_count
  from content_templates
  where content_templates.workspace_id = p_workspace_id;

  if v_count >= p_max_templates then
    return query select
      null::uuid, null::text, null::text, null::text, null::text, null::text,
      null::uuid, null::timestamptz, null::timestamptz, true;
    return;
  end if;

  insert into content_templates (workspace_id, title, category, body, source, origin_post_id)
  values (p_workspace_id, p_title, p_category, p_body, p_source, p_origin_post_id)
  returning * into v_row;

  return query select
    v_row.id, v_row.workspace_id, v_row.title, v_row.category, v_row.body,
    v_row.source, v_row.origin_post_id, v_row.created_at, v_row.updated_at, false;
end;
$$;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 100, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;
