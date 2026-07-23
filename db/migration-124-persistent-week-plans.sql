-- Migration 124: persist one seven-day agent plan per workspace/week.
--
-- A plan is intentionally a snapshot: source headlines, avatars, and generic
-- prompts stay stable while the user works through the week. Individual cards
-- carry the user's private story context and drafting state.

begin;

create table if not exists public.agent_week_plans (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  week_start date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, week_start)
);

create table if not exists public.agent_week_plan_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  plan_id uuid not null references public.agent_week_plans(id) on delete cascade,
  slot_index integer not null check (slot_index between 0 and 6),
  planned_for date not null,
  kind text not null check (kind in ('opportunity', 'generic')),
  opportunity_id uuid references public.agent_opportunities(id) on delete set null,
  prompt text,
  headline text,
  is_lead_magnet boolean not null default false,
  author_avatar text,
  user_context text,
  status text not null default 'planned'
    check (status in ('planned', 'drafting', 'drafted', 'dismissed')),
  drafted_artifact_id uuid references public.chat_artifacts(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (plan_id, slot_index),
  check (
    (kind = 'generic' and prompt is not null and opportunity_id is null)
    -- An opportunity may be deleted after it was planned. Keep the immutable
    -- snapshot card (headline/avatar) even when its live source becomes null.
    or (kind = 'opportunity' and prompt is null)
  )
);

create index if not exists agent_week_plan_items_workspace_plan_idx
  on public.agent_week_plan_items (workspace_id, plan_id, slot_index);

-- Parent + seven snapshot cards must appear together. A bare parent would
-- otherwise make a transient child insert failure look like a valid empty week
-- forever. The unique plan key also serializes concurrent first GETs.
create or replace function public.create_agent_week_plan(
  p_workspace_id text,
  p_week_start date,
  p_items jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_plan_id uuid;
begin
  insert into public.agent_week_plans (workspace_id, week_start)
  values (p_workspace_id, p_week_start)
  on conflict (workspace_id, week_start) do nothing
  returning id into v_plan_id;

  if v_plan_id is null then
    select id into v_plan_id
    from public.agent_week_plans
    where workspace_id = p_workspace_id and week_start = p_week_start;
    return v_plan_id;
  end if;

  insert into public.agent_week_plan_items (
    workspace_id, plan_id, slot_index, planned_for, kind, opportunity_id,
    prompt, headline, is_lead_magnet, author_avatar
  )
  select
    p_workspace_id,
    v_plan_id,
    item.slot_index,
    item.planned_for,
    item.kind,
    item.opportunity_id,
    item.prompt,
    item.headline,
    coalesce(item.is_lead_magnet, false),
    item.author_avatar
  from jsonb_to_recordset(p_items) as item(
    slot_index integer,
    planned_for date,
    kind text,
    opportunity_id uuid,
    prompt text,
    headline text,
    is_lead_magnet boolean,
    author_avatar text
  );

  return v_plan_id;
end;
$$;

alter table public.agent_week_plans enable row level security;
alter table public.agent_week_plan_items enable row level security;

create policy agent_week_plans_isolation on public.agent_week_plans
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());

create policy agent_week_plan_items_isolation on public.agent_week_plan_items
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 124, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
