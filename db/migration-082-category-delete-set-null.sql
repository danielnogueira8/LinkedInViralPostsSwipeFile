-- Workspace-private categories can be assigned to globally stored manual
-- accounts. Purging a workspace must preserve those shared account rows while
-- allowing the workspace-owned category to be deleted.

alter table accounts
  drop constraint if exists accounts_category_id_fkey;

alter table accounts
  add constraint accounts_category_id_fkey
  foreign key (category_id) references categories(id) on delete set null;
