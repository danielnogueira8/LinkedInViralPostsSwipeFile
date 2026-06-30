# User Skills — design doc

Bring-your-own skills for SwipeIn: users define reusable instruction sets ("write
a cold-DM teardown post", "my newsletter-promo format") and apply them in chat by
`/skill-name` or by picking them — the Claude-skills mental model, scoped to one
workspace.

Status: **design only, not built.** Decisions locked below; come back here to
implement.

---

## Why this is a smaller build than it looks

The agent **already has a skills system** — it's just hardcoded, not user-owned:

- `lib/agent/skills/index.ts` — `Skill = { id, triggers, body }`, a `SKILLS`
  array of built-ins (hooks, lead-magnet, voice-match, …), plus `selectSkills()`
  (keyword match) and `renderSkills()` (join bodies into one block).
- `lib/agent/run.ts:191` — `const skillBlock = renderSkills(selectSkills(latestUserText(history)))`,
  injected as a `system` message into the agent turn.
- The chat already has a **slash menu** (`STARTERS` + `slashQuery`/`slashMatches`
  in `chat-workspace.tsx` ~1209) — the `/skill-name` surface.
- `neutralizeMarkers()` (`lib/agent/untrusted.ts`) for sanitising pasted text.
- PDF/doc attachment parsing already exists in the stream route (not needed for v1
  — see formats below — but proves the capability is there).

So this feature = **expose the existing skills mechanism to user-authored,
DB-stored skills**, not build a new agent subsystem.

---

## Locked decisions

1. **Activation: explicit only.** A user skill applies ONLY when the user types
   `/skill-name`, `@mentions` it, or picks it from a menu. **No silent keyword
   auto-triggering** for user skills (avoids unpredictable collisions with the
   built-ins and with each other; matches the Claude "I'm using this skill now"
   model; simpler to build). The built-in keyword skills stay as they are.

2. **Formats: paste + `.md`/`.txt` upload only.** A textarea (the 80% case) plus
   uploading `.md`/`.txt` files (read as plain text client-side). **No PDF/`.docx`
   in v1** — they parse to messy prose that makes bad skills (a skill is
   structured instructions, not a document dump). Add later only if asked.

3. **New page: `/dashboard/skills`** (nav under "Content", next to Templates).
   List + create/edit/delete. Each skill: a name (the `/slug`), an optional short
   description, and the markdown body.

---

## Data model (migration 049)

New table `skills` (mirrors the multi-tenant pattern of `chat_artifacts` /
`saved_posts`: `workspace_id` = Clerk org id, RLS on, isolation via
`auth_workspace_id()`).

```sql
create table if not exists skills (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  -- The /slug used to invoke it. Lowercase, kebab-case, unique per workspace.
  slug text not null,
  -- Human display name + optional one-line description for the picker.
  name text not null,
  description text,
  -- The instruction block injected into the agent prompt (markdown). Capped.
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, slug)
);
create index if not exists skills_workspace_idx on skills(workspace_id, updated_at desc);
alter table skills enable row level security;
drop policy if exists skills_isolation on skills;
create policy skills_isolation on skills
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());
```

Caps to enforce in the API (zod): `slug` ≤ 40 + kebab regex, `name` ≤ 60,
`description` ≤ 160, `body` ≤ ~8000 chars (keep the per-turn token cost bounded;
the body rides into every turn that uses it).

---

## API routes

- `GET /api/skills` — list this workspace's skills (id, slug, name, description).
- `POST /api/skills` — create. Validate slug uniqueness (the table also enforces
  it); `neutralizeMarkers(body)` before store.
- `PATCH /api/skills/[id]` — edit name/description/body/slug.
- `DELETE /api/skills/[id]`.

All workspace-scoped via `scopedSupabase()` like the drafts routes.

---

## Chat wiring (the `/skill-name` activation)

The cleanest path that reuses the existing skill-injection point:

1. **Client (chat-workspace):**
   - Fetch the workspace's skills (slug + id) on mount (or pass from the server
     component, like `initialChats`).
   - Extend the slash menu: when the composer is `/<query>`, match BOTH the
     built-in `STARTERS` and the user skills by slug/name. Picking a user skill
     does NOT prefill a prompt — it **attaches the skill to the turn** (a small
     chip above the composer, like the model-source chip), and the user types
     their actual request.
   - On send, include the attached `skillIds: string[]` in the stream POST body.

2. **Stream route (`app/api/chats/[id]/stream/route.ts`):**
   - Add `skillIds: z.array(z.string().uuid()).max(3).optional()` to `bodySchema`.
   - Fetch those skills' bodies (workspace-scoped), `neutralizeMarkers` again
     (idempotent), and pass them into `runAgent`.

3. **Agent (`lib/agent/run.ts`):**
   - `runAgent` gains an optional `extraSkills: string[]` (the resolved bodies).
   - Fold them into the existing `skillBlock`: `renderSkills([...selected, ...userSkills])`
     — or just append the user-skill bodies to the same system block. They use
     the SAME injection mechanism that already works for built-ins.

This means **zero new agent plumbing** — user skills flow through the exact path
the built-in skills already use. The only new agent change is "also accept some
bodies passed in explicitly," not "build a selector / matcher."

### Activation UX detail
- Chip model (recommended): `/format-x` attaches a "Using: Format X" chip; the
  user then writes "...about our Q3 launch". The skill body + their message both
  go to the agent. Clear, and mirrors the existing model-source chip.
- Alternative (simpler, worse): `/format-x` just prefills the skill's *name* as
  text — but then the body isn't actually injected, so the agent doesn't get the
  instructions. Don't do this; the chip/skillIds path is the real one.

---

## Skills page UI (`/dashboard/skills`)

- **List**: cards/rows of `name` + `/slug` + description + edit/delete. Empty
  state explains "Skills are reusable instructions the agent applies when you type
  /name in chat."
- **Editor** (modal or drawer, reuse the post detail-drawer pattern): name, slug
  (auto-derived from name, editable), description, body (a plain textarea — or the
  same `DraftEditor` if we want formatting; plain textarea is fine since it's
  markdown). A "Upload .md/.txt" button that reads the file text into the body.
- **Slug**: auto-kebab from the name; show the `/slug` that will trigger it.

---

## Security / cost notes (don't hand-wave at build time)

- A skill body is user-authored and injected into THEIR OWN agent context, so the
  trust boundary is the same as their own message — low blast radius. Still:
  `neutralizeMarkers` the body (strip forged envelope markers), cap length, and
  cap how many skills attach per turn (≤3) so the prompt can't balloon.
- The skill body rides into every turn it's attached to → it counts toward the
  monthly token budget. The existing `claim_chat_turn` / usage logging already
  meters the turn; no separate accounting needed, but keep the body cap tight.
- Slug collisions: the unique constraint + a clear "slug taken" error.

---

## Out of scope for v1 (fast-follows)

- PDF/`.docx` upload (parse → text). The stream route already parses PDFs for
  attachments, so the capability exists; it's a UX/quality call, not a tech gap.
- Sharing skills between workspaces / a public skill library.
- Auto-trigger (keyword) user skills.
- Versioning / history of a skill body.

---

## Rough effort

Small-to-medium, because the agent half is mostly free:
- Migration 049 + 4 API routes: ~half a day.
- Skills page (list + editor + upload): ~1 day.
- Chat slash-menu + chip + skillIds plumbing + run.ts append: ~half a day.
- Tests (pure: slug derivation, skill resolution) + live verify: a few hours.

≈ 2–3 focused days for a solid v1. One PR (+ the migration), or split page vs.
chat-wiring into two PRs if you want to review incrementally.
