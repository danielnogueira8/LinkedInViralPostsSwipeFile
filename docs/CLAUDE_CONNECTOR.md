# Claude Custom Connector — setup guide

Wire this app's MCP server into **claude.ai → Settings → Connectors → Add custom connector** so you can ask things like _"give me the most viral AI post yesterday and adapt it"_ directly in claude.ai (web + mobile).

The connector is OAuth-protected by **Clerk** and every request is scoped to
the authenticated user's SwipeIn workspace.

## URL to paste into claude.ai

```
https://www.tryswipein.com/api/mcp
```

No client ID or secret is needed in the Advanced fields. Claude discovers the
Clerk authorization server from SwipeIn's protected-resource metadata.

## One-time setup

### Add the connector in claude.ai

1. claude.ai → **Settings → Connectors → Add custom connector**.
2. Paste the URL above.
3. Click **Connect** and sign in through Clerk.
4. SwipeIn's public tools become available in chat. The executable catalog in
   `lib/mcp/public-tools.ts` is the source of truth for the current list.

### Test prompts

> Give me the most viral AI post from the last 7 days and adapt it for my voice using the lara-acosta-linkedin skill.

> Add `linkedin.com/in/<some-handle>` to my tracked accounts under niche "AI".

> Show me the top 5 posts from the last scrape batch.

## How it works

- `app/api/[transport]/route.ts` mounts the official MCP TypeScript SDK v2
  HTTP handler at `/api/mcp`. It serves MCP 2026-07-28 requests directly and
  keeps stateless MCP 2025 clients compatible from the same tool registration.
- `lib/mcp/server.ts` owns the shared server factory; all public tools come
  from `lib/mcp/register.ts`, so modern and legacy clients cannot drift.
- `app/.well-known/oauth-protected-resource/route.ts` advertises Clerk as the
  authorization server (RFC 9728).
- `app/.well-known/oauth-authorization-server/route.ts` serves Clerk's OAuth
  metadata for older MCP clients that do not follow the resource pointer.
- `lib/mcp/clerk-auth.ts` verifies the Clerk OAuth bearer token and binds every
  tool request to the authenticated user's workspace.
- The Supabase service role key is used server-side only — claude.ai never sees it.

## Rich UI (MCP Apps)

Hosts that support the MCP Apps extension (SEP-1865) — Claude, ChatGPT,
VS Code — render the list/visual tools as interactive SwipeIn-styled cards
instead of a wall of JSON:

- `search_viral_posts` opens the full interactive Swipe File app
  (`ui://swipein/swipe-file-v2.html`).
- `get_post` and `get_top_from_batch` render post cards
  (`ui://swipein/post-cards`) with author avatar, clamped body, media, and
  engagement pills.
- `list_saved_posts` renders bookmark cards (`ui://swipein/saved-posts`) with
  category and note.
- `list_drafts` renders Posts-board cards (`ui://swipein/drafts`) with status,
  kind, and schedule chips.

Each tool declares its view via `_meta.ui.resourceUri` and returns
`structuredContent` alongside the unchanged text JSON — hosts without the
extension ignore the metadata and keep working exactly as before. The views
themselves are self-contained HTML resources (`lib/mcp/ui/*`) served with the
`text/html;profile=mcp-app` MIME type and a CSP that allows LinkedIn CDN
media plus the DiceBear CDN (`api.dicebear.com`) used for creator-avatar
fallbacks.

## Security notes

- The service role key has full DB access and remains server-side only. Every
  tool handler must keep using the workspace id derived from the verified
  Clerk token; never accept a workspace id from tool arguments or headers.
- Rotate Clerk and Supabase credentials immediately if either leaks.

## Local development

The connector flow won't work end-to-end locally because claude.ai can only reach public HTTPS URLs. For local development of tools themselves, use the stdio variant in `mcp-server/` instead (see `mcp-server/README.md`).
