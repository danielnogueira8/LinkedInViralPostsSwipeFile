-- Migration 099: Separate interview-save timestamp from synthesis timestamp
--
-- BUG: POST /api/voice/interview (the standalone "answer questions before
-- ever scraping" path) stamped `generated_at` on the row it created — the
-- SAME column startVoiceGeneration()/voiceRegenCooldown() (see
-- lib/voice-profile-operations.ts) read to gate the 7-day voice-refresh
-- cooldown. `generated_at` means "a real synthesis run completed"; an
-- interview-only save is not a synthesis run. An interview-first user (who
-- never ran POST /api/voice) would immediately hit the cooldown wall the
-- first time they tried to actually generate their voice from a scrape,
-- with no synthesis ever having happened.
--
-- FIX: `interview_updated_at` records "the interview was last saved",
-- entirely separate from `generated_at` ("a synthesis run last completed").
-- app/api/voice/interview/route.ts stamps this instead of generated_at on
-- both the insert (standalone) and update (existing profile) paths.
--
-- Nullable: existing rows have never had an interview save recorded.
--
-- Run order: idempotent. Safe to re-run.

alter table voice_profiles
  add column if not exists interview_updated_at timestamptz;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 99, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;
