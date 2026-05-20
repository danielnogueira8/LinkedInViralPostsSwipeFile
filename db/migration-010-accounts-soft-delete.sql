-- Adds soft-delete to accounts so removal via the MCP server (and any future
-- UI surface) is reversible. The scraper, swipe page, and dashboards must
-- exclude archived accounts going forward.

alter table accounts
  add column if not exists archived_at timestamptz;

create index if not exists accounts_active_idx
  on accounts (id)
  where archived_at is null;
