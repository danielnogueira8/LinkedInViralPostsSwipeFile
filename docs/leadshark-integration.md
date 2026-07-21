# LeadShark integration — deploy & ops runbook

Comment-triggered auto-DM for lead-magnet posts. A creator connects their own
LeadShark API key; SwipeIn stores it encrypted and (Phase 2) creates LeadShark
automations when lead-magnet posts publish.

This doc covers what an operator must do to ship and run Phase 1
(credentials + Integrations UI). Phases 2–3 add their own steps.

## Phase 0 probe — verified against the live API

Run against a real LeadShark Pro key + a connected LinkedIn account. Results:

- **Auth + API access:** `GET /api/automations?limit=1` → 200. A Pro plan
  includes API access.
- **Post listing:** `GET /api/v1/posts` returns posts published OUTSIDE LeadShark,
  each with `post_id` in the **`urn:li:activity:…`** namespace and a `share_url`
  embedding the **same** numeric id. So the default `url_match` binding strategy
  works — no need for `LEADSHARK_BINDING_STRATEGY=snapshot_diff`.
- **Create:** `POST /api/automations` → 201, accepts the full field set we send
  (`keywords`, `dm_template`, `dm_templates`, `comment_reply_template`,
  `non_first_degree_reply_template`, `enable_follow_up` + the follow-up fields,
  `auto_connect`) and echoes them back intact. Read-back `post_id` matches
  exactly. `links_enabled` defaults to false (plain URLs, no Pro+ needed).
- **Template vars:** `{{fullNameMention}}` is confirmed live (round-trips) and is
  now allowed. `{{lastName}}` never appeared in any response and stays refused.
- **Follow-up:** a second follow-up slot (`follow_up_template_2`) exists; v1
  sends one (§9.2).

Still unverified (need a second LinkedIn account to comment): does a keyword
comment actually trigger a DM end-to-end, retroactive-comment behavior, and
whether blank keywords truly DM every commenter.

## New environment variable — `CREDENTIAL_ENCRYPTION_KEY`

The first user-supplied secret in the app. LeadShark API keys are stored as
AES-256-GCM ciphertext (`lib/crypto.ts`); this variable is the encryption key.

- **Format:** 32 bytes, base64-encoded.
- **Generate:** `openssl rand -base64 32`
- **Per environment:** use a DIFFERENT value in preview and production. A leaked
  preview key must not decrypt production ciphertext.
- **Fail-closed:** `lib/crypto.ts` throws at module load if the key is missing or
  not exactly 32 decoded bytes. Any route that imports the credential path
  (`/dashboard/integrations`, `/api/integrations/leadshark`) will 500 until the
  key is set. Set it BEFORE deploying this feature.
- **Key loss = credential loss (by design).** Losing the key makes every stored
  LeadShark credential permanently undecryptable. There is no recovery path; a
  `key_version` column exists so a future rotation can be additive.

Set it in Vercel (Production + Preview, separate values) and, for local dev, in
`.env.local`.

### Optional override — `LEADSHARK_API_BASE_URL`

Defaults to `https://apex.leadshark.io`. Only set this to point the client at a
staging/probe base; leave unset in production.

## Migration

- `db/migration-120-integration-credentials.sql` — the encrypted-credential
  table. Generic by `provider` (first provider: `leadshark`). RLS-isolated;
  advances `app_schema_version` to 120.
- Migrations are applied MANUALLY (see `docs/migrations.md`). Apply 120 in
  Supabase before or with this deploy — the app reads/writes this table on the
  Integrations page.

PR checklist (from `docs/migrations.md`):
`npm run migrations:metadata` → `npm run migrations:check` → apply in Supabase →
`npm run migrations:readiness` → deploy.

## Secret handling — invariants

These are enforced in code; keep them true in any change:

1. `ciphertext` / `iv` / `auth_tag` are selected ONLY inside
   `lib/leadshark-credentials.ts`. Everything else uses the safe projection
   `{ connected, status, keyHint, lastVerifiedAt }`.
2. No API route returns the key. The connect field is write-only — there is no
   "reveal key".
3. The key is never logged. Sentry's `beforeSend` (`lib/sentry-config.ts`,
   `scrubSentryEvent`) redacts `x-api-key`, `authorization`, and the credential
   columns from every event, including secrets riding on a thrown fetch error.
4. Decrypt at point of use (`getDecryptedKey`); never persist the plaintext past
   the request/job.
5. Every credential query carries an explicit `.eq("workspace_id", …)`. RLS is
   defense-in-depth; the app-layer filter is load-bearing.

## Validating a key at connect time

`POST /api/integrations/leadshark` never stores an unvalidated key. It calls
`GET /api/automations?limit=1` on LeadShark first:

- `200` → encrypt, upsert, mark active.
- `401` → "LeadShark rejected your API key." Store nothing.
- `403` → plan lacks API access (needs Pro or above). Store nothing.
- `429` → rate-limited; ask the user to retry. Store nothing.
- network / 5xx → "Couldn't reach LeadShark." Store nothing.

## Rollback

The whole feature is removable by dropping the tables it owns (migration 120
here; 121–122 in Phase 2) and reverting the code. No existing tables change.
