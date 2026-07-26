-- Migration 130: atomically replace one Context interview knowledge revision.
--
-- Voice saves remain available during a Knowledge rollout failure, so the
-- Knowledge operation itself must be all-or-nothing. This function validates
-- the complete replacement set, retires the prior revision with audit rows,
-- inserts every new proposal, and verifies the resulting set in one database
-- transaction.

begin;

create or replace function public.replace_interview_workspace_knowledge(
  p_workspace_id text,
  p_source_ref_prefix text,
  p_proposals jsonb
)
returns setof public.workspace_knowledge_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  proposal_count integer;
  persisted_count integer;
  current_item public.workspace_knowledge_items;
begin
  if nullif(btrim(p_workspace_id), '') is null then
    raise exception 'Workspace id is required' using errcode = '22023';
  end if;
  if p_source_ref_prefix is null
    or p_source_ref_prefix !~ '^[A-Za-z0-9_-]{1,80}:interview:$'
  then
    raise exception 'Invalid interview source prefix' using errcode = '22023';
  end if;
  if p_proposals is null or jsonb_typeof(p_proposals) <> 'array' then
    raise exception 'Interview proposals must be an array' using errcode = '22023';
  end if;

  proposal_count := jsonb_array_length(p_proposals);
  if proposal_count > 10 then
    raise exception 'Too many interview proposals' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_proposals) proposal
    where jsonb_typeof(proposal) <> 'object'
      or not (
        proposal ?& array[
          'schema_version', 'proposal_key', 'kind', 'title',
          'content', 'identity_ref', 'source_ref', 'confidence'
        ]
      )
      or exists (
        select 1 from jsonb_object_keys(proposal) key
        where key not in (
          'schema_version', 'proposal_key', 'kind', 'title',
          'content', 'identity_ref', 'source_ref', 'confidence'
        )
      )
      or proposal->>'proposal_key' !~ '^[0-9a-f]{64}$'
      or left(
        coalesce(proposal->>'identity_ref', ''),
        length(p_source_ref_prefix)
      ) <> p_source_ref_prefix
      or substring(
        coalesce(proposal->>'identity_ref', '')
        from length(p_source_ref_prefix) + 1
      ) !~ '^[a-z0-9_]{1,60}$'
      or left(
        coalesce(proposal->>'source_ref', ''),
        length(proposal->>'identity_ref') + 1
      ) <> proposal->>'identity_ref' || ':'
  ) then
    raise exception 'Invalid interview proposal payload' using errcode = '22023';
  end if;

  if (
    select count(distinct proposal->>'identity_ref')
    from jsonb_array_elements(p_proposals) proposal
  ) <> proposal_count then
    raise exception 'Duplicate interview question' using errcode = '22023';
  end if;
  if (
    select count(distinct proposal->>'proposal_key')
    from jsonb_array_elements(p_proposals) proposal
  ) <> proposal_count then
    raise exception 'Duplicate interview proposal key' using errcode = '22023';
  end if;

  -- A first save has no rows to lock. The transaction-scoped advisory lock
  -- also serializes that empty-set case, preventing two concurrent interview
  -- revisions from both becoming active.
  perform pg_advisory_xact_lock(
    hashtextextended(p_workspace_id || ':' || p_source_ref_prefix, 0)
  );

  -- Serialize concurrent saves for this Voice profile before deciding what
  -- belongs to the prior revision.
  perform 1
  from public.workspace_knowledge_items item
  where item.workspace_id = p_workspace_id
    and item.source = 'interview'
    and item.active
    and item.source_ref like p_source_ref_prefix || '%'
  for update;

  for current_item in
    select item.*
    from public.workspace_knowledge_items item
    where item.workspace_id = p_workspace_id
      and item.source = 'interview'
      and item.active
      and item.source_ref like p_source_ref_prefix || '%'
      and not exists (
        select 1
        from jsonb_array_elements(p_proposals) proposal
        where left(
            item.source_ref,
            length(proposal->>'identity_ref') + 1
          ) = proposal->>'identity_ref' || ':'
          and item.kind = proposal->>'kind'
          and item.title = proposal->>'title'
          and item.content = proposal->'content'
      )
  loop
    if current_item.verification = 'proposed' then
      perform set_config('app.workspace_knowledge_operation', 'review', true);
      update public.workspace_knowledge_items item set
        verification = 'rejected',
        last_verified_at = null,
        active = false,
        updated_at = now()
      where item.id = current_item.id;

      insert into public.workspace_knowledge_reviews (
        workspace_id, item_id, decision, previous_item, replacement
      ) values (
        p_workspace_id, current_item.id, 'reject',
        to_jsonb(current_item), null
      );
    elsif current_item.verification = 'verified' then
      perform set_config('app.workspace_knowledge_operation', 'archive', true);
      update public.workspace_knowledge_items item set
        active = false,
        updated_at = now()
      where item.id = current_item.id;

      insert into public.workspace_knowledge_reviews (
        workspace_id, item_id, decision, previous_item, replacement
      ) values (
        p_workspace_id, current_item.id, 'archive',
        to_jsonb(current_item), null
      );
    else
      raise exception 'Unexpected active interview knowledge state'
        using errcode = '55000';
    end if;
  end loop;

  insert into public.workspace_knowledge_items (
    schema_version,
    workspace_id,
    proposal_key,
    kind,
    title,
    content,
    source,
    source_ref,
    confidence,
    verification,
    last_verified_at,
    active
  )
  select
    (proposal->>'schema_version')::integer,
    p_workspace_id,
    proposal->>'proposal_key',
    proposal->>'kind',
    proposal->>'title',
    proposal->'content',
    'interview',
    proposal->>'source_ref',
    (proposal->>'confidence')::double precision,
    'proposed',
    null,
    true
  from jsonb_array_elements(p_proposals) proposal
  where not exists (
    select 1
    from public.workspace_knowledge_items item
    where item.workspace_id = p_workspace_id
      and item.source = 'interview'
      and item.active
      and left(
        item.source_ref,
        length(proposal->>'identity_ref') + 1
      ) = proposal->>'identity_ref' || ':'
      and item.kind = proposal->>'kind'
      and item.title = proposal->>'title'
      and item.content = proposal->'content'
  )
  on conflict (workspace_id, proposal_key) do nothing;

  select count(*) into persisted_count
  from public.workspace_knowledge_items item
  where item.workspace_id = p_workspace_id
    and item.source = 'interview'
    and item.active
    and exists (
      select 1
      from jsonb_array_elements(p_proposals) proposal
      where left(
          item.source_ref,
          length(proposal->>'identity_ref') + 1
        ) = proposal->>'identity_ref' || ':'
        and item.kind = proposal->>'kind'
        and item.title = proposal->>'title'
        and item.content = proposal->'content'
    );

  if persisted_count <> proposal_count then
    raise exception 'Interview knowledge revision was not fully persisted'
      using errcode = '40001';
  end if;

  return query
  select item.*
  from public.workspace_knowledge_items item
  where item.workspace_id = p_workspace_id
    and item.source = 'interview'
    and item.active
    and exists (
      select 1
      from jsonb_array_elements(p_proposals) proposal
      where left(
          item.source_ref,
          length(proposal->>'identity_ref') + 1
        ) = proposal->>'identity_ref' || ':'
        and item.kind = proposal->>'kind'
        and item.title = proposal->>'title'
        and item.content = proposal->'content'
    )
  order by item.created_at, item.id;
end;
$$;

revoke all on function public.replace_interview_workspace_knowledge(
  text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.replace_interview_workspace_knowledge(
  text, text, jsonb
) to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 130, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
