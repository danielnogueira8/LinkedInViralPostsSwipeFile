# Security notes

Practical guide to the security-relevant pieces of this codebase. Read before
touching the chat renderer, the agent loop, or any code that ingests scraped
LinkedIn content. Not a generic security policy — this is *what specifically
matters here* and *what would break if you got it wrong*.

---

## The threat model in one paragraph

The chat agent reads **untrusted scraped LinkedIn post content** (a creator
controls what's in their posts), runs in a **logged-in user session** that has
access to **other drafts and tools**, and **renders agent output to the browser**.
Those three together — private data, untrusted content, external comms — are
what Simon Willison calls the [lethal trifecta][trifecta]. Bing Chat, Microsoft
Copilot Chat, Claude.ai, and Google NotebookLM all shipped exfiltration bugs
through this exact pattern. We avoid it by structurally **blocking the "external
comms" leg** in the browser.

[trifecta]: https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/

---

## Load-bearing defenses (don't break these)

### 1. The renderer is markdown-restricted

`app/(app)/dashboard/chat-workspace.tsx → renderInline` / `renderRichText`
deliberately only handle **bold, italic, blockquotes**. No images, no links,
no HTML, no auto-loaded URLs.

⚠️ **Do NOT add markdown image or link rendering** to this component without:
1. Revisiting the `Content-Security-Policy` in `next.config.ts` (the
   `img-src` / `connect-src` allowlists).
2. Adding an **output-side safety screen** for agent text (a separate small
   LLM call that scans for system-prompt leakage / cross-tenant data / suspect
   patterns before display).
3. Removing the `auto-load` behavior — links should require a click; images
   should require an explicit user action.

The same applies to `InlineSourceCard` if you start rendering markdown inside
cited post text.

### 2. Content-Security-Policy is set in `next.config.ts`

The CSP locks `img-src` and `connect-src` to a **specific allowlist** — no
wildcards. This makes browser-driven exfiltration via image src / fetch
structurally impossible *even if* the renderer ever leaked an attacker URL.

If you add a feature that legitimately needs a new external origin, add the
**specific host** to the allowlist. Don't widen the policy to `*`.

The full directive table and rationale lives at the top of `next.config.ts`.

### 3. Scraped content is "neutralized" at ingest

`lib/agent/untrusted.ts → neutralizeMarkers` strips/escapes the delimiter
markers we use in agent envelopes (`--- POST TO MODEL AFTER ---`, etc.) from
scraped post bodies, so a creator can't write a fake delimiter into their post
to break out of the data envelope.

This is applied at **both ingest AND retrieval** (defense in depth) — see
`app/api/model-source/route.ts` and `lib/cite-resolve.ts`.

### 4. Tool calls are workspace-scoped server-side

The chat agent's tools (`lib/agent/tools.ts`) take `workspaceId` from the
**server session**, never from model arguments. Every DB query is gated by
`.in("account_id", trackedAccountIds(workspaceId))` with a
`NO_ROWS_SENTINEL` fallback so an empty list never degenerates into "no filter."

A hallucinated UUID or one belonging to another workspace **structurally cannot
return data** — the scope gate is the second of two defenses (the first being
UUID format validation).

### 5. The agent system prompt treats tool results as DATA

The agent system prompt has explicit instructions to treat scraped post text
and tool results as data, never as instructions. This is a **soft**
defense — it can be defeated by sufficiently clever injection — which is why
the **hard** defenses (CSP, scoping, neutralization) above matter more.

### 6. The chat agent does NOT have any write tools

Tools are read-only (`search_viral_posts`, `get_voice`, `get_post`, etc.). The
agent cannot write to the DB, send emails, modify accounts, or call external
APIs. **Keep it that way** — adding any write tool opens an attacker-controlled
action surface and would require revisiting the threat model.

### 7. Image input is disabled

`chat-workspace.tsx → classifyFile` rejects image uploads in the composer. The
chat model is text-only and we don't want to add a multi-modal injection vector.

---

## If you're shipping a feature that touches any of these

Quick mental checklist:

- [ ] Are you rendering agent output? → Does it bypass `renderInline` / `renderRichText`?
- [ ] Are you adding a new tool? → Is it read-only? Workspace-scoped server-side?
- [ ] Are you ingesting new untrusted content? → Does it pass through `neutralizeMarkers`?
- [ ] Are you loading a new external origin? → Did you add it to CSP, *specifically*?
- [ ] Are you persisting attacker-controllable content? → Is it neutralized before storage *and* re-neutralized on read?

If any of these is "I don't know," ask before merging.

---

## What's NOT covered (be honest)

- **Output-side safety screen.** We don't yet run a second-pass LLM check on
  agent output before display. The structural defenses (restricted renderer +
  CSP) cover the worst-case exfil channel; the screen would cover subtler
  leaks like system-prompt extraction. Worth adding before paid users.
- **Supabase RLS verification.** App-level scoping is solid; whether RLS is
  also enforced at the database policy level needs to be verified.
- **Rate limiting on a per-account basis** beyond the existing money ceiling
  on chat usage.
- **Audit log of agent actions** for incident response.

Reach out before touching anything in this file or relaxing any of the
load-bearing defenses above.
