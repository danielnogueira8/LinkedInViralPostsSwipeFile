-- Tracks where each account came from so sheet sync can't overwrite manually
-- added rows. Existing rows default to 'sheet' since that's how they got in.

alter table accounts
  add column if not exists source text not null default 'sheet'
  check (source in ('sheet', 'manual'));

create index if not exists accounts_source_idx on accounts(source);
