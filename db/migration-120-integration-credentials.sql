-- Migration 120: encrypted third-party integration credentials.
--
-- The FIRST user-supplied secret in the app. Every provider key today is a
-- platform env var (ZERNIO_API_KEY, Anthropic, Apify); this table holds a key
-- the USER pastes — starting with LeadShark. A leaked key can send DMs and
-- connection requests from the user's real LinkedIn account, so the secret is
-- stored as AES-256-GCM ciphertext (lib/crypto.ts), never plaintext.
--
-- Generic by `provider` so the next integration reuses the same table + RLS.
-- unique (workspace_id, provider) is correct under workspace_id == user_id
-- (one user per workspace, no org layer — lib/workspace.ts).
--
-- The ciphertext / iv / auth_tag columns are read ONLY inside
-- lib/leadshark-credentials.ts; everything else uses the safe projection
-- { connected, status, keyHint, lastVerifiedAt }. RLS is defense-in-depth —
-- the app also enforces isolation with an explicit .eq("workspace_id", ...) on
-- every query (RLS is bypassed by the service-role client).

begin;

create table if not exists public.integration_credentials (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  provider text not null check (provider in ('leadshark')),
  ciphertext text not null,            -- AES-256-GCM, base64
  iv text not null,                    -- base64, 12-byte nonce (unique per encryption)
  auth_tag text not null,              -- base64 GCM auth tag
  key_version smallint not null default 1,
  key_hint text,                       -- display only, e.g. "••••3f9a" (a hash tail, not key bytes)
  status text not null default 'active'
    check (status in ('active', 'invalid', 'revoked')),
  last_verified_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, provider)
);

create index if not exists integration_credentials_workspace_idx
  on public.integration_credentials (workspace_id);

alter table public.integration_credentials enable row level security;

drop policy if exists integration_credentials_isolation on public.integration_credentials;
create policy integration_credentials_isolation on public.integration_credentials
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 120, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
