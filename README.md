# LinkedIn Viral Posts Swipe File

Internal tool that:
1. Daily-scrapes the last post from a list of LinkedIn accounts (from a public Google Sheet) via Apify
2. Flags posts as "viral" by tunable thresholds
3. Auto-generates fill-in-the-blank templates with Claude
4. Lets you copy an image-recreation prompt for graphic visuals, recolored to a selected client's brand palette

## Stack
Next.js 16 (App Router) · Supabase (Postgres) · Apify (`apimaestro/linkedin-profile-posts`) · Anthropic Claude (templating + vision) · Vercel (hosting + cron)

## Setup

### 1. Create the database
In your Supabase project, open SQL Editor and run [`db/schema.sql`](db/schema.sql).

### 2. Configure env
`.env.local` is already populated with your keys. **Set `CRON_SECRET` to a random string before deploying.**

### 3. Local dev
```bash
npm install
npm run dev
```
Visit http://localhost:3000.

### 4. First run
1. Open **Accounts** → click **Sync sheet** to pull 72 accounts from the Google Sheet
2. Click **Scrape now** to fetch each account's last post via Apify (this takes a few minutes)
3. Viral posts (≥200 reactions OR ≥50 comments) appear under **Swipe File**, with auto-generated templates under **Templates**

### 5. Clients & image prompts
1. Open **Clients** → add a client with brand colors
2. On any viral post with a graphic visual (auto-classified by Claude vision), click **Copy image prompt** → pick the client → prompt is copied to clipboard

### 6. Deploy
```bash
vercel
```
Set all `.env.local` vars in Vercel project settings. Cron is configured in [`vercel.json`](vercel.json) to run daily at 08:00 UTC, calling `/api/cron/daily` with `Authorization: Bearer $CRON_SECRET`.

## Tweaks
- **Viral thresholds**: change in `/settings` (re-evaluates all stored posts)
- **Schedule**: edit `vercel.json` cron expression
- **Add/remove accounts**: edit the Google Sheet, then click "Sync sheet" (or wait for the next daily cron)

## Layout
```
app/
  (dashboard)/
    page.tsx            ← dashboard
    swipe/              ← viral post grid
    templates/          ← post + template side-by-side
    clients/            ← brand palette CRUD
    accounts/           ← synced sheet view + sync/scrape buttons
    settings/           ← threshold tuning
  api/
    sync-accounts       ← POST: pull sheet → upsert accounts
    scrape-now          ← POST: run pipeline manually
    cron/daily          ← GET: bearer-auth daily entry point
    templates           ← POST: regenerate template for a post
    image-prompt        ← POST: generate (or cache) image prompt
    clients             ← GET/POST/DELETE
    settings            ← GET/POST thresholds
lib/
  sheets.ts             ← public-CSV parser
  apify.ts              ← actor run + post normalizer
  claude.ts             ← templatize, classify visual, image prompt
  viral.ts              ← scoring + thresholds
  pipeline.ts           ← end-to-end daily job
  supabase.ts           ← admin/browser client + types
db/
  schema.sql            ← Postgres schema (run once)
```
