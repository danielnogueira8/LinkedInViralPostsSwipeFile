# SwipeIn

A multi-tenant SaaS that helps LinkedIn creators, founders, and agencies go from blank page to booked calendar. It scrapes a daily swipe file of viral posts from creators you track, drafts posts in your voice with an AI agent ("Cowork"), and lets you plan them on a calendar and publish to LinkedIn — all in one workspace.

## What it does

- **Swipe File** — daily-scraped viral posts (via Apify) from up to 100 creators per workspace, scored and filterable by niche, date, and virality.
- **Cowork** — a chat agent that reads your voice profile and what's working in your niche, then drafts posts, hooks, and lead magnets as editable draft cards.
- **Posts board + calendar** — a pipeline (idea → drafting → ready → posted) and a planning calendar; connected workspaces can schedule approved drafts to auto-publish on LinkedIn (via Zernio).
- **Voice, Creator Styles, Templates, Custom Skills** — reusable inputs that shape how drafts are written.
- **Lead Magnets** — generate markdown resources (with images) for comment-to-DM posts.
- **Claude MCP connector** — use your swipe file straight from claude.ai.

## Stack

Next.js 16 (App Router) · Supabase (Postgres + RLS) · Clerk (auth, multi-tenant orgs) · OpenRouter (all LLM calls) · Apify (LinkedIn scraping) · Zernio (LinkedIn publishing) · Vercel (hosting + cron)

## Setup

### 1. Create the database

The schema is defined by **sequential migrations**, not a single dump — `db/schema.sql` is the original pre-multi-tenancy scaffold and is **not** sufficient to run the app. In the Supabase SQL Editor, run every file listed in `db/migrations.json` in order. Run `npm run migrations:check` to verify the chain and [`docs/migrations.md`](docs/migrations.md) for deployment readiness.

### 2. Configure env

Copy your keys into `.env.local`. The **required** variables (the app cannot function without them) are:

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `OPENROUTER_API_KEY` — all LLM traffic routes through OpenRouter
- `CRON_SECRET` — Bearer secret guarding the cron endpoints (set to a random string)

Other integrations are configured as needed: Clerk (`CLERK_*`), Apify (`APIFY_API_TOKEN`, `APIFY_ACTOR_ID`), Zernio (`ZERNIO_API_KEY`), and the optional `HEALTH_DIGEST_WEBHOOK` (Slack/Discord URL for the daily cost digest and cron-failure alerts). Many tuning knobs (`OPENROUTER_*_MODEL`, `AGENT_*`, `VIRAL_*`) have safe in-code defaults.

Newsjacking follows the app-wide chat model when it supports grounded discovery, otherwise it falls back to `anthropic/claude-haiku-4.5`. Set `OPENROUTER_NEWS_MODEL` to `openai/gpt-5.6-luna`, `google/gemini-3.1-flash-lite`, `anthropic/claude-haiku-4.5`, or `z-ai/glm-5.2` to override only that research pipeline without changing the main Cowork writer model.

### 3. Local dev

```bash
npm install
npm run dev
```

Visit http://localhost:3000.

### 4. Deploy

```bash
vercel
```

Set all `.env.local` vars in the Vercel project settings. Crons are configured in [`vercel.json`](vercel.json) and authenticate with `Authorization: Bearer $CRON_SECRET`:

Sentry is connected to `swipein/swipein-prod`. For production source maps, add
this variable to Vercel:

- `SENTRY_AUTH_TOKEN` — a CI-scoped token used only while building to upload source maps

The public project DSN and project slugs are configured in code; they are not
secrets. `NEXT_PUBLIC_SENTRY_DSN` can still override the DSN when needed.
Production traces are sampled at 10%; errors are always captured. Source maps
are deleted after a successful upload.
Vercel's deployment label is exposed automatically so preview and production
events remain separated in Sentry.

- `cron/daily` — daily scrape enqueue + cost digest
- `cron/jobs` — drains the background-job queue (scrape, lead-magnet generation, voice/creator-style jobs)
- `cron/publish-scheduled` — publishes due LinkedIn posts (every 5 min)
- `cron/sweep-media` — garbage-collects soft-deleted media assets

Run any new migration's SQL in Supabase **before** deploying the code that depends on it — see [`docs/migrations.md`](docs/migrations.md).

## Testing

```bash
npx vitest run      # unit/integration suite (evals/data)
npx tsc --noEmit    # typecheck
```

CI runs the suite and Playwright UI checks on every PR (`.github/workflows/`); nightly stability evals exercise the live agent.

## Layout

```
app/
  (marketing)/          ← public landing, pricing, terms, privacy
  (app)/dashboard/      ← the authenticated app
    page.tsx            ← Cowork (chat home)
    posts/              ← pipeline board + planning calendar
    swipe/              ← viral swipe file
    accounts/           ← tracked creators ("Content Sources")
    voice/ creator-styles/ templates/ skills/  ← drafting inputs
    lead-magnets/  branding/  settings/
  api/                  ← ~40 route groups: chats, drafts, batch, creator-styles,
                          lead-magnets, media-assets, cron, webhooks, zernio, …
lib/                    ← agent loop (lib/agent), pipeline, scraping, publishing,
                          scheduling, media, voice, OpenRouter client, env validation
db/                     ← migration-NNN-*.sql (run in order)
evals/data/             ← vitest suite
```

## Tweaks

- **Viral thresholds**: `/dashboard/settings` (re-evaluates stored posts).
- **Cron schedule**: edit `vercel.json`.
- **Tracked creators**: managed per workspace under Content Sources (up to 100 each).
