# Claude Custom Connector — setup guide

Wire this app's MCP server into **claude.ai → Settings → Connectors → Add custom connector** so you can ask things like _"give me the most viral AI post yesterday and adapt it"_ directly in claude.ai (web + mobile).

The connector is OAuth-protected via **WorkOS AuthKit** with an email allow-list.

## URL to paste into claude.ai

```
https://linked-in-viral-posts-swipe-file.vercel.app/api/mcp
```

No client ID / secret needed in the "Advanced" fields — claude.ai does dynamic client registration against AuthKit.

## One-time setup

### 1. Apply the soft-delete migration (if not already)

Run `db/migration-010-accounts-soft-delete.sql` in the Supabase SQL editor.

### 2. Create a WorkOS application

1. Sign up at <https://workos.com>, create an **Application**.
2. Copy the **Client ID** and **API Key**.
3. **Redirects** → add `https://linked-in-viral-posts-swipe-file.vercel.app/callback` (and `http://localhost:3000/callback` for local).
4. **Authentication → AuthKit** → enable. Pick or note the **AuthKit Domain** (looks like `https://<tenant>.authkit.app`).
5. **Applications → Configuration** → enable **Dynamic Client Registration** (DCR). Required for claude.ai to register itself as a client.
6. Same page → enable **Client ID Metadata Document (CIMD)** and add `https://linked-in-viral-posts-swipe-file.vercel.app` as a **Resource Indicator**.
7. Under AuthKit's sign-in methods, enable **Google OAuth** (and any others you want).

### 3. Set Vercel env vars

In the Vercel project settings → Environment Variables (Production):

| Name | Value |
| --- | --- |
| `WORKOS_API_KEY` | `sk_live_...` from WorkOS |
| `WORKOS_CLIENT_ID` | `client_...` from WorkOS |
| `WORKOS_COOKIE_PASSWORD` | output of `openssl rand -base64 32` (at least 32 chars) |
| `NEXT_PUBLIC_WORKOS_REDIRECT_URI` | `https://linked-in-viral-posts-swipe-file.vercel.app/callback` |
| `AUTHKIT_DOMAIN` | `https://<tenant>.authkit.app` |
| `MCP_ALLOWED_EMAILS` | `danielhenriquesnogueira@gmail.com` (comma-separate for multiple) |

`SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` should already be set.

Redeploy after setting them.

### 4. Add the connector in claude.ai

1. claude.ai → **Settings → Connectors → Add custom connector**.
2. Paste the URL above.
3. Click **Connect** → AuthKit opens → sign in with the allow-listed Google account.
4. The 9 tools (`search_viral_posts`, `get_post`, `list_niches`, `get_top_from_batch`, `list_accounts`, `add_account`, `update_account`, `remove_account`, `restore_account`) become available in chat.

### 5. Test prompts

> Give me the most viral AI post from the last 7 days and adapt it for my voice using the lara-acosta-linkedin skill.

> Add `linkedin.com/in/<some-handle>` to my tracked accounts under niche "AI".

> Show me the top 5 posts from the last scrape batch.

## How it works

- `app/api/[transport]/route.ts` mounts the MCP server over **Streamable HTTP** at `/api/mcp` using [`mcp-handler`](https://github.com/vercel/mcp-handler). All 9 tools come from `lib/mcp/register.ts`.
- `app/.well-known/oauth-protected-resource/route.ts` advertises AuthKit as the authorization server (RFC 9728). Without this, claude.ai can't discover where to send users to log in.
- `app/.well-known/oauth-authorization-server/route.ts` proxies AuthKit's OAuth metadata for older MCP clients that don't follow the resource-metadata pointer.
- `lib/mcp/workos-auth.ts` verifies the bearer JWT against AuthKit's JWKS, fetches the WorkOS user, and rejects anyone not in `MCP_ALLOWED_EMAILS` with a 401.
- The Supabase service role key is used server-side only — claude.ai never sees it.

## Security notes

- The service role key has full DB access. Restricting `MCP_ALLOWED_EMAILS` is the only thing keeping a random WorkOS user from running tools — keep this list tight.
- Rotate `WORKOS_API_KEY` if it ever leaks; the connector keeps working as long as JWKS lookups still succeed.
- Per-user scoping (so different users see different accounts) would require row-level security on Supabase. Out of scope for this single-user setup.

## Local development

The connector flow won't work end-to-end locally because claude.ai can only reach public HTTPS URLs. For local development of tools themselves, use the stdio variant in `mcp-server/` instead (see `mcp-server/README.md`).
