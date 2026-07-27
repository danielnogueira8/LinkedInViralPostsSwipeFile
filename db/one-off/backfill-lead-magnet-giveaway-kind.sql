-- One-off backfill: drafts carrying a lead-magnet giveaway must be
-- kind='lead_magnet', not 'post'.
--
-- The giveaway signal lives in chat_artifacts.meta.lead_magnet (stamped by the
-- chat/agent save paths and the New-post picker). Rows written before
-- resolveDraftKind enforced "giveaway ⇒ lead_magnet" could keep kind='post',
-- which hid the board's Lead Magnet badge, the kind filter, and the
-- comment-to-DM automation (gated on kind='lead_magnet'). Migration 055 fixed
-- the older meta.is_lead_magnet signal; this covers meta.lead_magnet.
--
-- Safe to re-run; only touches matching rows.
update chat_artifacts
set kind = 'lead_magnet'
where kind = 'post'
  and btrim(coalesce(meta->'lead_magnet'->>'title', '')) <> '';
