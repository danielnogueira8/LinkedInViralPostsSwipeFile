-- Add per-account progress tracking + phase to runs so any tab can see live state
alter table runs add column if not exists progress jsonb not null default '[]'::jsonb;
alter table runs add column if not exists phase text;
alter table runs add column if not exists phase_msg text;
