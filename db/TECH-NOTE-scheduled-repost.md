# Tech note: scheduled "repost after N hours" — NOT built (platform blocker)

**Status:** assessed, deliberately not implemented (2026-07-03).
**Ask:** auto-repost a scheduled LinkedIn post a few hours after it publishes.
**Verdict:** the *scaffolding* would be clean, but a **true repost is impossible on
the current Zernio integration**, and the only mechanical alternative
(re-publishing identical content) is guaranteed to fail. Per the "no hacky
workaround" instruction, nothing was shipped. This note records why, and exactly
what would unblock it.

---

## What "repost" means, and why it can't be done here

A LinkedIn **repost / reshare** is a first-class action: it re-surfaces the
*existing* post (keeping its engagement and showing "X reposted this"). It
requires an API that reshares a post **by its URN/id**.

Our publishing goes through Zernio (`lib/zernio.ts`). The client exposes exactly
these endpoints:

| Function | Endpoint | Purpose |
|---|---|---|
| `createLinkedInPost` | `POST /v1/posts` (`publishNow: true`) | publish a **new** post |
| `listAccounts` | `GET /v1/accounts` | list connected accounts |
| `createProfile` | `POST /v1/profiles` | per-workspace container |
| `getConnectUrl` | `GET /v1/connect/{platform}` | start OAuth |
| `deleteAccount` | `DELETE /v1/accounts/{id}` | disconnect |

**There is no reshare / repost / share-by-URN endpoint.** (`lib/zernio.ts:86-149`.)
Grepping the codebase, every other "repost" reference is a *scraped engagement
metric* — `reposts` counts read off other people's posts (`lib/viral.ts:44`,
`lib/apify.ts:8`, `lib/agent/tools.ts`), never a publish action.

Two further facts confirmed while assessing:

1. **`firstComment` is NOT a reusable "delayed second action."** It rides inside
   the *same* `POST /v1/posts` call as `platformSpecificData.firstComment`
   (`lib/zernio.ts:104-116`) and Zernio auto-posts it after publish. There is no
   existing "do X after the post is live" scheduled pattern to piggyback a repost
   onto — a repost would have to be its own scheduled row.
2. **The `createLinkedInPost` response gives us Zernio's internal `_id`, not a
   LinkedIn post URN** (`lib/zernio.ts:147`). Even if a reshare endpoint appeared,
   we'd need to confirm it accepts what we capture.

### Why the "just re-publish the same content" workaround fails

The only mechanical way to fake a repost with the current API is to call
`createLinkedInPost` again with the same body. **LinkedIn rejects
identical/near-identical content with a 422 duplicate**, and our stack *already*
classifies that as a **permanent, never-retried failure**:

- `lib/zernio.ts:37,45-54` — `kind: "duplicate"` for 422 / "duplicate".
- `lib/publishing.ts:224-227` — `const retryable = err.kind !== "duplicate" && …`

So an identical-content repost would land in `schedule_status='failed'` **every
single time**. It's not a repost, it's a guaranteed error. Varying the content
enough to dodge the 422 would make it a *different* post — no longer a repost of
the original — which is not what was asked for.

---

## The architecture is ready — it's purely a platform gap

For the record, the *rest* of the design would have been straightforward, because
scheduling here is a denormalized state machine on `chat_artifacts` driven by a
5-minute claim-and-publish cron. A repost is that same pattern a second time.

**Existing publish state machine** (`db/migration-057-linkedin-publishing.sql`):
`scheduled → publishing (atomic CAS claim) → published | failed`, cron
`*/5 * * * *` (`vercel.json`), atomic claim at `lib/publishing.ts:173-181`,
success/failure handling at `:198-240`.

**What a repost would have added (do NOT build until the blocker below clears):**

- Columns on `chat_artifacts`, mirroring the publish set:
  `repost_enabled bool`, `repost_delay_hours int`, `repost_at timestamptz`,
  `repost_status text check (… 'scheduled','publishing','published','failed')`,
  `repost_zernio_post_id text`, `reposted_at timestamptz`,
  `repost_error text`, `repost_attempts int default 0`, plus a partial index on
  `(repost_status, repost_at) where repost_status='scheduled'`.
- On the *original's* successful publish (`lib/publishing.ts:198-217`), also stamp
  `repost_at = published_at + repost_delay_hours` and `repost_status='scheduled'`
  — anchoring the repost to the **real published time**, so a delayed publish
  still spaces the repost correctly, and guaranteeing the repost is only ever
  armed *after* a successful publish (requirement: no repost if the original
  fails).
- A second due-scan in `publishDueDrafts` over `repost_status='scheduled'`,
  reusing the **identical** compare-and-swap claim (`scheduled → publishing`) for
  idempotency / no-duplicate-on-retry.
- UI: one more row in `ScheduleRow` (`app/(app)/dashboard/draft-editor-modal.tsx`)
  — a "Repost N hours after publishing" toggle + number input, stacked in the
  existing `flex-col gap-2`. (Note: there is no workspace-default-settings pattern
  to mirror for a default delay — one would need adding.)

The claim mechanism, connection resolution, Zernio error mapping, and retry
budget would all be reused verbatim. **The only missing piece is a reshare API
call to put in the middle** — and that's exactly what doesn't exist.

---

## What would unblock this later

Any ONE of:

1. **A Zernio reshare endpoint** — e.g. `POST /v1/posts/{id}/reshare` or a
   `reshareOf: <urn>` field on `POST /v1/posts`. Then the repost job calls that
   with the original's stored `zernio_post_id` instead of re-publishing content.
   (Check `docs.zernio.com` — the client's connect endpoints already carry a
   "adapt to Zernio's guide" caveat, so their surface may grow.)
2. **Direct LinkedIn reshare API access** — LinkedIn's UGC/Posts API supports
   resharing a share by URN. That's a larger integration (own OAuth scope, not
   via Zernio) and only worth it if reposting becomes a core need.
3. **Product reframe** — if "auto-publish a *follow-up* post X hours later" (a
   distinct second post, with varied content to avoid the 422) is acceptable,
   the scaffolding above builds cleanly. That is a different feature from a
   repost and should be named honestly to the user. Not built here because the
   ask was specifically a *repost of the same post*.

Until (1) or (2) exists, a genuine repost cannot be honored, and re-publishing
identical content is a guaranteed duplicate-failure — so it was left unbuilt on
purpose.
