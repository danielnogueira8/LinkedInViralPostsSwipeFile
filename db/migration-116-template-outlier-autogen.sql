-- Migration 116: auto-generated templates from genuine creator outliers.
--
-- The pipeline's templating phase (lib/pipeline.ts) turns a creator's genuine
-- outlier posts (decideTemplateOutlier in lib/viral.ts: top 5% of the creator's
-- own scores over at least 20 stored posts) into generic fill-in-the-blank
-- templates and fans them out to every workspace tracking that account.
--
--   1. Widen the content_templates.source CHECK with 'auto' for these rows
--      ('custom' = user-authored, 'builtin' = reserved for forked built-ins).
--   2. Add a unique partial index on (workspace_id, origin_post_id) so a
--      re-scrape of the same post can never file a duplicate template — the
--      idempotency backstop under concurrent runs and the backfill script.
--      Partial so user-authored rows (origin_post_id NULL) are unaffected.
--
-- Idempotent: drop-then-add constraint + create-if-not-exists index. Safe to
-- re-run.

begin;

-- 1. Widen the provenance check to include 'auto'.
alter table public.content_templates
  drop constraint if exists content_templates_source_check;

alter table public.content_templates
  add constraint content_templates_source_check
  check (source in ('custom', 'builtin', 'auto'));

-- 2. At most one template per workspace per origin post.
create unique index if not exists content_templates_workspace_origin_post_idx
  on public.content_templates (workspace_id, origin_post_id)
  where origin_post_id is not null;

-- 3. Bump schema version.
insert into public.app_schema_version (singleton, version, updated_at)
values (true, 116, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
