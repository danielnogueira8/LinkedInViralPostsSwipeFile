-- Migration 178: a durable home for profile avatars.
--
-- voice_profiles.avatar_url stores the URL Apify scraped off LinkedIn, and
-- LinkedIn's CDN URLs are time-limited — they expire after days or weeks. The
-- render path already degrades gracefully (lib/../avatar-img.tsx falls to the
-- Clerk photo, then to initials), but the underlying URL was never refreshed
-- for a workspace's OWN profile, so every voice profile eventually shows a
-- fallback instead of the user's face. Tracked creators do not have this
-- problem: lib/pipeline.ts refreshes accounts.profile_pic_url on every scrape.
--
-- Rather than add another refresh job racing an expiry we do not control, copy
-- the image once into storage we own and keep serving that.
--
-- PUBLIC bucket, deliberately, and it is the one real decision here. The
-- media-assets bucket is private and hands out signed URLs
-- (MEDIA_LIBRARY_SIGNED_URL_SECONDS), which would recreate the exact bug this
-- migration exists to end: an avatar URL with an expiry date. The contents are
-- public LinkedIn profile pictures — already served from an unauthenticated
-- CDN to anyone with the link — so a public object grants no access that did
-- not already exist. Paths are keyed by workspace so one workspace cannot
-- overwrite another's, and nothing else is ever written here.

begin;

do $$
begin
  if to_regclass('storage.buckets') is not null then
    execute $bucket$
      insert into storage.buckets (id, name, public)
      values ('profile-avatars', 'profile-avatars', true)
      on conflict (id) do update set public = true
    $bucket$;
  end if;
end;
$$;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 178, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
