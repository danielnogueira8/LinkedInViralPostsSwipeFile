-- Migration 065: persist the live plan checklist on the chat row.
--
-- The Cowork plan checklist (write_plan / update_plan → PlanStep[]) is streamed
-- live and held only in the client's in-memory run. When a full-page navigation
-- destroys that run mid-turn, the checklist is gone — and #773 could only bring
-- back a generic "still working…" indicator, not the literal steps, because the
-- plan lived nowhere durable.
--
-- `chats.live_plan` stores the CURRENT plan steps for an in-flight turn as JSONB
-- (the same PlanStep[] the client renders: {id,label,status}). The stream route
-- writes it whenever the plan changes and clears it (NULL) when the turn settles,
-- so it's only ever populated while a turn is running. A returning client reads
-- it via GET /api/chats/[id] alongside `running` and re-renders the real
-- checklist. Small and bounded (plans are 2-6 short steps), so the per-update
-- write is cheap; it's cleared on settle so it never accumulates.
alter table chats
  add column if not exists live_plan jsonb;

comment on column chats.live_plan is
  'Live PlanStep[] for the in-flight Cowork turn (NULL when idle). Lets a client that navigated away and back restore the plan checklist. Cleared when the turn settles.';
