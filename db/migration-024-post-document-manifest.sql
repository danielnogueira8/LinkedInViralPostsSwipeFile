-- Migration 024: store the document manifest URL for PDF carousels
--
-- harvestapi only returns ~3 pre-rendered cover-page images per PDF
-- document, but LinkedIn exposes a `manifestUrl` that (two hops later)
-- lists EVERY page image. We store that URL + the total page count so
-- the UI can fetch the full deck on demand (see /api/post-document).
--
-- NOTE: the manifest URL is short-lived (signed, ~7-day expiry). It only
-- resolves while fresh — for documents from actively-scraped accounts.
-- When it 403s/expires, the UI falls back to the cover-page images
-- already stored in media_urls. This is the intended "full deck while
-- fresh, graceful degradation when stale" behavior (option 3).
--
-- Both columns nullable — only document posts have them. Run order:
-- idempotent.

alter table posts
  add column if not exists document_manifest_url text;

alter table posts
  add column if not exists document_page_count int;
