# linkedin-swipe-mcp

A local **stdio MCP server** that exposes the LinkedIn viral swipe file (read-only) and the tracked-accounts table (read/write) to Claude.

Plug it into Claude Code / Claude Desktop and you can run prompts like:

> _"Give me the most viral AI post from yesterday and adapt it for me."_
>
> _"Add `linkedin.com/in/danielnogueira` to my tracked accounts under niche 'AI'."_
>
> _"Show me the top 3 posts from the last scrape batch."_

## Prerequisites

1. **Run migration 010** on the Supabase project first — it adds the `archived_at` soft-delete column the `remove_account` / `restore_account` tools depend on:

   ```bash
   psql "$SUPABASE_DB_URL" -f ../db/migration-010-accounts-soft-delete.sql
   ```

2. The same Supabase env vars the Next app uses:
   - `SUPABASE_URL` (or `NEXT_PUBLIC_SUPABASE_URL`)
   - `SUPABASE_SERVICE_ROLE_KEY`

## Install + build

```bash
cd mcp-server
npm install
npm run build
```

## Wire it up to Claude Code

Add to `~/.claude.json` under the project's `mcpServers`:

```json
{
  "mcpServers": {
    "linkedin-swipe": {
      "command": "node",
      "args": ["/Users/danielnogueira/LinkedInViralPostsSwipeFile/mcp-server/dist/index.js"],
      "env": {
        "SUPABASE_URL": "https://<project>.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "<service-role-key>"
      }
    }
  }
}
```

Restart Claude Code. The 9 tools below should appear under `linkedin-swipe`.

## Tools

### Read-only — swipe file

| Tool | Purpose |
| --- | --- |
| `search_viral_posts` | Filter by niche, date range (`since` 1d/7d/30d or `from`/`to`), `min_reactions`, `min_comments`, `post_type` (`regular`/`lead_magnet`), `sort` (`viral`/`reactions`/`comments`/`posted`), `dir`, `limit`. |
| `get_post` | Full post by id (text, URL, engagement, media, generated template if any). |
| `list_niches` | All niches across active accounts with counts. |
| `get_top_from_batch` | Top N posts from the most recent successful scrape run. |

### Read/write — tracked accounts

| Tool | Purpose |
| --- | --- |
| `list_accounts` | Filter by niche or substring `search` on name/handle. `include_archived` defaults to false. |
| `add_account` | Upsert on `profile_url`. Re-adding an archived handle un-archives it. New niches accepted as-is. |
| `update_account` | Patch `name` and/or `niche`. Identify by exactly one of `id` / `linkedin_handle` / `profile_url`. The `protect_account_niche` DB trigger still blocks clearing a non-null niche via UPDATE. |
| `remove_account` | Soft delete — sets `archived_at`. Historical posts stay in the DB. |
| `restore_account` | Clears `archived_at`. |

## Notes

- All tools use the Supabase **service role** key — there is no per-user auth. Don't expose this server beyond your local machine.
- Reads filter `accounts.archived_at IS NULL` so archived accounts disappear from swipe results immediately. The Next app reads do not yet apply this filter — follow-up work.
- `add_account` is idempotent on the normalized `profile_url`, mirroring `app/api/accounts/manual/route.ts`.
- No scrape is triggered after `add_account`; the next daily run will pick the new handle up.
