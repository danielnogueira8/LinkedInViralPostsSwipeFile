-- Migration 154: exact, workspace-aware Source Post count.
begin;

create or replace function public.count_source_posts(
  p_workspace_id text,
  p_account_ids uuid[],
  p_category_id text,
  p_niche text,
  p_query text,
  p_since timestamptz,
  p_from timestamptz,
  p_to timestamptz,
  p_min_reactions integer,
  p_min_comments integer,
  p_post_type text,
  p_require_positive_baseline boolean,
  p_regular_enabled boolean,
  p_regular_min_likes integer,
  p_lead_magnet_enabled boolean,
  p_lead_magnet_min_comments integer
)
returns bigint
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  source_post_count bigint;
begin
  if nullif(btrim(p_workspace_id), '') is null then
    raise exception 'Workspace id is required' using errcode = '22023';
  end if;
  if (p_account_ids is null) = (p_category_id is null) then
    raise exception 'Exactly one Source Post scope is required'
      using errcode = '22023';
  end if;
  if p_account_ids is not null and cardinality(p_account_ids) = 0 then
    return 0;
  end if;
  if p_post_type is not null
    and p_post_type not in ('regular', 'lead_magnet') then
    raise exception 'Invalid Source Post type' using errcode = '22023';
  end if;

  select count(*)
  into source_post_count
  from public.posts post
  join public.accounts creator on creator.id = post.account_id
  left join public.workspace_post_classification classification
    on classification.workspace_id = p_workspace_id
    and classification.post_id = post.id
  where post.is_viral = true
    and creator.archived_at is null
    and (
      classification.post_id is null
      or classification.is_viral = true
    )
    and (
      (
        p_account_ids is not null
        and post.account_id = any(p_account_ids)
      )
      or (
        p_category_id is not null
        and creator.category_id = p_category_id
        and exists (
          select 1
          from public.workspace_accounts membership
          where membership.workspace_id = p_workspace_id
            and membership.account_id = post.account_id
        )
      )
    )
    and (
      (
        post.post_type = 'regular'
        and (
          not p_regular_enabled
          or post.reactions >= p_regular_min_likes
        )
      )
      or (
        post.post_type = 'lead_magnet'
        and (
          not p_lead_magnet_enabled
          or post.comments >= p_lead_magnet_min_comments
        )
      )
    )
    and (p_niche is null or creator.niche ilike p_niche)
    and (
      p_query is null
      or to_tsvector('english', coalesce(post.text, ''))
        @@ websearch_to_tsquery('english', p_query)
    )
    and (p_since is null or post.posted_at >= p_since)
    and (p_from is null or post.posted_at >= p_from)
    and (p_to is null or post.posted_at <= p_to)
    and (
      p_min_reactions is null
      or post.reactions >= p_min_reactions
    )
    and (
      p_min_comments is null
      or post.comments >= p_min_comments
    )
    and (p_post_type is null or post.post_type = p_post_type)
    and (
      not p_require_positive_baseline
      or post.baseline_score > 0
    );

  return source_post_count;
end;
$$;

revoke all on function public.count_source_posts(
  text, uuid[], text, text, text, timestamptz, timestamptz, timestamptz,
  integer, integer, text, boolean, boolean, integer, boolean, integer
) from public, anon, authenticated, service_role;
grant execute on function public.count_source_posts(
  text, uuid[], text, text, text, timestamptz, timestamptz, timestamptz,
  integer, integer, text, boolean, boolean, integer, boolean, integer
) to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 154, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
