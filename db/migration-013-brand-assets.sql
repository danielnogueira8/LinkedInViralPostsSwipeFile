-- Migration 013: Brand assets on clients
--
-- The "Clients" tab is being rebranded to "Branding" — each workspace's
-- brand profile now carries a logo URL and font choices alongside the
-- existing brand_colors / notes. New columns are nullable so existing
-- rows keep working without backfill.
--
-- Run order: idempotent. Safe to re-run.

alter table clients
  add column if not exists logo_url text,
  add column if not exists font_primary text,
  add column if not exists font_secondary text;
