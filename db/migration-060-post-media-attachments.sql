-- Migration 060: post media attachments for Zernio publishing
--
-- Stores Zernio-uploaded media metadata on the user's own draft rows. The
-- actual files live in Zernio media storage and are referenced by publicUrl in
-- create-post mediaItems. The app validates LinkedIn's media rules before
-- schedule/publish; this JSON column keeps the metadata with the draft.

alter table chat_artifacts
  add column if not exists media_attachments jsonb not null default '[]'::jsonb;

