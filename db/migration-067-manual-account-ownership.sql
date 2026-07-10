-- Migration 067: assign ownership to globally stored manual creator rows.
--
-- `accounts` is shared across workspaces so one scrape can serve everyone.
-- Manual creator metadata was mutable by any workspace that tracked the row,
-- allowing a second workspace to rename or recategorize another workspace's
-- creator. Ownership makes those global mutations explicit and enforceable.

alter table accounts
  add column if not exists manual_owner_workspace_id text;

-- A legacy row with exactly one tracking workspace has an unambiguous owner.
-- Shared rows remain null and globally read-only: tracking history cannot prove
-- which workspace originally created the row after historical untracks.
with sole_owners as (
  select account_id, min(workspace_id) as workspace_id
  from workspace_accounts
  group by account_id
  having count(*) = 1
)
update accounts a
set manual_owner_workspace_id = s.workspace_id
from sole_owners s
where a.id = s.account_id
  and a.source = 'manual'
  and a.manual_owner_workspace_id is null;
