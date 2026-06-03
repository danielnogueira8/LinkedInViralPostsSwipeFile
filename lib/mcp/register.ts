import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ServerRequest,
  ServerNotification,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { trackedAccountIds } from "@/lib/supabase-scoped";
import {
  errorContent,
  handleFromUrl,
  jsonContent,
  normalizeProfileUrl,
  parseDayEnd,
  parseDayStart,
  sinceCutoff,
} from "./util";
import {
  authorHandleFromProfileUrl,
  authorHandleFromUrl,
  canonicalPostUrl,
  displayNameFromHandle,
  extractUrnFromUrl,
  fetchHandleViaRedirect,
  fetchOEmbed,
  postUrlForUrn,
  postUrlFromUrn,
  probeEmbedUrn,
} from "@/lib/linkedin-url";

const POST_TYPES = ["regular", "lead_magnet"] as const;
const SORT_COLUMN = {
  viral: "viral_score",
  reactions: "reactions",
  comments: "comments",
  posted: "posted_at",
} as const;

const POST_COLS =
  "id, text, post_url, posted_at, reactions, comments, reposts, media_type, media_urls, visual_kind, scraped_at, post_type, is_viral, account_id, accounts!inner(id, name, niche, linkedin_handle, profile_pic_url), templates(id, template_text)";

const NO_ROWS_SENTINEL = "00000000-0000-0000-0000-000000000000";

function normalizeEmbed<T extends { accounts: unknown }>(p: T) {
  return {
    ...p,
    accounts: Array.isArray(p.accounts) ? (p.accounts[0] ?? null) : p.accounts,
  };
}

/**
 * Pull the workspace id stamped onto the auth token by `verifyToken`.
 * Returns the workspace id or null. Tool handlers should return `errorContent`
 * with a 401-equivalent message when this is null — that path means the
 * caller authenticated but isn't a member of any Clerk org.
 */
type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

function workspaceFromExtra(extra: Extra): string | null {
  const wsId = extra.authInfo?.extra?.workspaceId;
  return typeof wsId === "string" && wsId.length > 0 ? wsId : null;
}

const NO_WORKSPACE_MSG =
  "No workspace bound to this session. Join a workspace before using MCP tools.";

export function registerSwipeTools(server: McpServer) {
  // -------------------------------------------------------------------------
  // Read-only: swipe file (scoped to the workspace's tracked accounts)
  // -------------------------------------------------------------------------

  server.registerTool(
    "search_viral_posts",
    {
      title: "Search viral posts",
      description:
        "Search the viral swipe file. Filter by niche, date range, engagement thresholds, and post type. Returns top matching posts from accounts your workspace tracks.",
      inputSchema: {
        niche: z.string().optional().describe("Exact account niche, e.g. 'AI', 'SaaS'."),
        since: z
          .enum(["1d", "7d", "30d"])
          .optional()
          .describe("Relative window from now: posts posted within the last 1, 7, or 30 days."),
        from: z.string().optional().describe("Absolute lower bound on posted_at as YYYY-MM-DD."),
        to: z.string().optional().describe("Absolute upper bound on posted_at as YYYY-MM-DD."),
        min_reactions: z.number().int().nonnegative().optional(),
        min_comments: z.number().int().nonnegative().optional(),
        post_type: z.enum(POST_TYPES).optional(),
        sort: z
          .enum(["viral", "reactions", "comments", "posted"])
          .optional()
          .describe("Sort key. Default 'viral' (composite viral_score)."),
        dir: z.enum(["asc", "desc"]).optional().describe("Default 'desc'."),
        limit: z.number().int().min(1).max(50).optional().describe("Default 10, max 50."),
      },
    },
    async (args, extra) => {
      try {
        const workspaceId = workspaceFromExtra(extra);
        if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
        const accountIds = await trackedAccountIds(workspaceId);
        const sb = supabaseAdmin();
        const sortKey = args.sort ?? "viral";
        const sortCol = SORT_COLUMN[sortKey];
        const ascending = args.dir === "asc";
        const limit = args.limit ?? 10;

        let q = sb
          .from("posts")
          .select(POST_COLS)
          .in("account_id", accountIds.length ? accountIds : [NO_ROWS_SENTINEL])
          .eq("is_viral", true)
          .is("accounts.archived_at", null)
          .order(sortCol, { ascending, nullsFirst: false })
          .limit(limit);

        if (args.niche) q = q.eq("accounts.niche", args.niche);
        const sinceIso = sinceCutoff(args.since);
        const fromIso = parseDayStart(args.from);
        const toIso = parseDayEnd(args.to);
        if (sinceIso) q = q.gte("posted_at", sinceIso);
        if (fromIso) q = q.gte("posted_at", fromIso);
        if (toIso) q = q.lte("posted_at", toIso);
        if (args.min_reactions !== undefined) q = q.gte("reactions", args.min_reactions);
        if (args.min_comments !== undefined) q = q.gte("comments", args.min_comments);
        if (args.post_type) q = q.eq("post_type", args.post_type);

        const { data, error } = await q;
        if (error) return errorContent(error.message);
        const posts = (data ?? []).map(normalizeEmbed);
        return jsonContent({ ok: true, count: posts.length, posts });
      } catch (e) {
        return errorContent((e as Error).message);
      }
    },
  );

  server.registerTool(
    "get_post",
    {
      title: "Get post by id",
      description:
        "Fetch a single post by id, including the generated template if one exists. Only returns posts from accounts your workspace tracks.",
      inputSchema: { id: z.string().uuid().describe("Post UUID.") },
    },
    async ({ id }, extra) => {
      try {
        const workspaceId = workspaceFromExtra(extra);
        if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
        const accountIds = await trackedAccountIds(workspaceId);
        if (accountIds.length === 0) return errorContent(`No post found with id ${id}`);

        const sb = supabaseAdmin();
        const { data, error } = await sb
          .from("posts")
          .select(POST_COLS)
          .eq("id", id)
          .in("account_id", accountIds)
          .maybeSingle();
        if (error) return errorContent(error.message);
        if (!data) return errorContent(`No post found with id ${id}`);
        return jsonContent({ ok: true, post: normalizeEmbed(data) });
      } catch (e) {
        return errorContent((e as Error).message);
      }
    },
  );

  server.registerTool(
    "list_niches",
    {
      title: "List niches",
      description:
        "List niches across your workspace's tracked (non-archived) accounts, with counts.",
      inputSchema: {},
    },
    async (_args, extra) => {
      try {
        const workspaceId = workspaceFromExtra(extra);
        if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
        const accountIds = await trackedAccountIds(workspaceId);
        if (accountIds.length === 0) return jsonContent({ ok: true, niches: [] });

        const sb = supabaseAdmin();
        // Prefer the per-workspace niche override; fall back to the global account niche.
        const { data, error } = await sb
          .from("workspace_accounts")
          .select("niche, accounts!inner(niche, archived_at)")
          .eq("workspace_id", workspaceId)
          .is("accounts.archived_at", null);
        if (error) return errorContent(error.message);

        const counts = new Map<string, number>();
        for (const row of (data ?? []) as Array<{
          niche: string | null;
          accounts: { niche: string | null } | { niche: string | null }[];
        }>) {
          const acc = Array.isArray(row.accounts) ? row.accounts[0] : row.accounts;
          const n = row.niche ?? acc?.niche ?? null;
          if (!n) continue;
          counts.set(n, (counts.get(n) ?? 0) + 1);
        }
        const niches = [...counts.entries()]
          .map(([niche, count]) => ({ niche, count }))
          .sort((a, b) => b.count - a.count || a.niche.localeCompare(b.niche));
        return jsonContent({ ok: true, niches });
      } catch (e) {
        return errorContent((e as Error).message);
      }
    },
  );

  server.registerTool(
    "get_top_from_batch",
    {
      title: "Get top posts from the most recent scrape batch",
      description:
        "Returns the highest-engagement posts from your workspace's tracked accounts collected in the most recent successful scrape run.",
      inputSchema: {
        limit: z.number().int().min(1).max(20).optional().describe("Default 5, max 20."),
      },
    },
    async ({ limit }, extra) => {
      try {
        const workspaceId = workspaceFromExtra(extra);
        if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
        const accountIds = await trackedAccountIds(workspaceId);
        if (accountIds.length === 0) {
          return jsonContent({ ok: true, posts: [], note: "Workspace tracks no accounts." });
        }

        const sb = supabaseAdmin();
        const { data: lastRun, error: runErr } = await sb
          .from("runs")
          .select("started_at, finished_at")
          .eq("status", "ok")
          .order("started_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (runErr) return errorContent(runErr.message);
        if (!lastRun?.started_at) {
          return jsonContent({ ok: true, posts: [], note: "No successful scrape run found yet." });
        }
        const { data, error } = await sb
          .from("posts")
          .select(POST_COLS)
          .in("account_id", accountIds)
          .eq("is_viral", true)
          .is("accounts.archived_at", null)
          .gte("scraped_at", lastRun.started_at)
          .order("reactions", { ascending: false, nullsFirst: false })
          .limit(limit ?? 5);
        if (error) return errorContent(error.message);
        return jsonContent({
          ok: true,
          run: lastRun,
          count: data?.length ?? 0,
          posts: (data ?? []).map(normalizeEmbed),
        });
      } catch (e) {
        return errorContent((e as Error).message);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Read/write: workspace's tracked accounts
  // Mutations target `workspace_accounts` (per-workspace tracking + niche
  // override). The global `accounts` row is created on track-by-URL so the
  // scraper has something to point at, but it's never renamed or archived
  // via MCP — that would cross-contaminate other workspaces.
  // -------------------------------------------------------------------------

  server.registerTool(
    "list_accounts",
    {
      title: "List tracked accounts",
      description:
        "List accounts your workspace tracks, optionally filtered by niche or name/handle search.",
      inputSchema: {
        niche: z.string().optional(),
        search: z
          .string()
          .optional()
          .describe("Case-insensitive substring match on name or handle."),
        include_archived: z
          .boolean()
          .optional()
          .describe(
            "Default false. Archived = the global account row has archived_at set.",
          ),
        limit: z.number().int().min(1).max(200).optional().describe("Default 50, max 200."),
      },
    },
    async (args, extra) => {
      try {
        const workspaceId = workspaceFromExtra(extra);
        if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
        const sb = supabaseAdmin();

        // Pull this workspace's join rows + their global account.
        let q = sb
          .from("workspace_accounts")
          .select(
            "niche, added_at, accounts!inner(id, name, linkedin_handle, profile_url, niche, source, synced_at, archived_at)",
          )
          .eq("workspace_id", workspaceId)
          .order("name", { foreignTable: "accounts", ascending: true })
          .limit(args.limit ?? 50);

        if (!args.include_archived) q = q.is("accounts.archived_at", null);
        if (args.niche) {
          // niche match: per-workspace override OR (override null AND global niche match)
          q = q.or(
            `niche.eq.${args.niche},and(niche.is.null,accounts.niche.eq.${args.niche})`,
          );
        }
        if (args.search) {
          const s = args.search.replace(/[%_]/g, "");
          q = q.or(
            `name.ilike.%${s}%,linkedin_handle.ilike.%${s}%`,
            { foreignTable: "accounts" },
          );
        }

        const { data, error } = await q;
        if (error) return errorContent(error.message);

        const accounts = ((data ?? []) as Array<{
          niche: string | null;
          added_at: string;
          accounts:
            | {
                id: string;
                name: string;
                linkedin_handle: string;
                profile_url: string;
                niche: string | null;
                source: string;
                synced_at: string;
                archived_at: string | null;
              }
            | Array<{
                id: string;
                name: string;
                linkedin_handle: string;
                profile_url: string;
                niche: string | null;
                source: string;
                synced_at: string;
                archived_at: string | null;
              }>;
        }>).map((r) => {
          const acc = Array.isArray(r.accounts) ? r.accounts[0] : r.accounts;
          return {
            ...acc,
            workspace_niche: r.niche,
            effective_niche: r.niche ?? acc?.niche ?? null,
            tracked_at: r.added_at,
          };
        });
        return jsonContent({ ok: true, count: accounts.length, accounts });
      } catch (e) {
        return errorContent((e as Error).message);
      }
    },
  );

  server.registerTool(
    "add_account",
    {
      title: "Track a LinkedIn account for this workspace",
      description:
        "Track a LinkedIn profile under this workspace. Idempotent on profile_url. Creates the global account row if it's new (source='manual'); otherwise reuses the existing catalog row and just adds the workspace_accounts tracking. The optional `niche` is stored as a per-workspace override.",
      inputSchema: {
        profile_url: z
          .string()
          .describe("Any linkedin.com/in/<handle> URL. Normalized server-side."),
        name: z
          .string()
          .min(1)
          .describe(
            "Display name for the account. Only used when creating a new global row; existing rows keep their existing name.",
          ),
        niche: z
          .string()
          .optional()
          .describe(
            "Free-form niche label, e.g. 'AI'. Stored as a per-workspace override; doesn't change the global account niche.",
          ),
      },
    },
    async ({ profile_url, name, niche }, extra) => {
      try {
        const workspaceId = workspaceFromExtra(extra);
        if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
        const url = normalizeProfileUrl(profile_url);
        if (!url) return errorContent("Invalid LinkedIn profile URL.");
        const sb = supabaseAdmin();

        // 1. Resolve or create the global account row.
        const { data: existing, error: lookupErr } = await sb
          .from("accounts")
          .select("id, name, linkedin_handle, profile_url, niche, source, synced_at, archived_at")
          .eq("profile_url", url)
          .maybeSingle();
        if (lookupErr) return errorContent(lookupErr.message);

        let account = existing;
        if (!account) {
          const { data: created, error: insErr } = await sb
            .from("accounts")
            .insert({
              name: name.trim(),
              profile_url: url,
              linkedin_handle: handleFromUrl(url),
              niche: niche?.trim() || null,
              source: "manual",
              synced_at: new Date().toISOString(),
            })
            .select("id, name, linkedin_handle, profile_url, niche, source, synced_at, archived_at")
            .single();
          if (insErr || !created) return errorContent(insErr?.message ?? "insert failed");
          account = created;
        }

        // 2. Track for this workspace (idempotent — onConflict on (workspace_id, account_id)).
        const { error: trackErr } = await sb.from("workspace_accounts").upsert(
          {
            workspace_id: workspaceId,
            account_id: account.id,
            niche: niche?.trim() || null,
          },
          { onConflict: "workspace_id,account_id" },
        );
        if (trackErr) return errorContent(trackErr.message);

        return jsonContent({
          ok: true,
          account: {
            ...account,
            workspace_niche: niche?.trim() || null,
            effective_niche: niche?.trim() || account.niche,
          },
          created_new_catalog_row: !existing,
        });
      } catch (e) {
        return errorContent((e as Error).message);
      }
    },
  );

  server.registerTool(
    "update_account",
    {
      title: "Update the per-workspace niche on a tracked account",
      description:
        "Update the per-workspace niche override for an account this workspace tracks. The global account's display name is intentionally not editable via MCP — it would affect every other workspace tracking the same creator.",
      inputSchema: {
        id: z.string().uuid().optional().describe("Account UUID."),
        linkedin_handle: z.string().optional(),
        profile_url: z.string().optional(),
        niche: z
          .string()
          .nullable()
          .describe(
            "Per-workspace niche override. Pass null to clear (so the global account niche shows through).",
          ),
      },
    },
    async (args, extra) => {
      try {
        const workspaceId = workspaceFromExtra(extra);
        if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
        const idents = [args.id, args.linkedin_handle, args.profile_url].filter(Boolean);
        if (idents.length !== 1) {
          return errorContent("Provide exactly one of: id, linkedin_handle, profile_url.");
        }
        const sb = supabaseAdmin();

        // Resolve to a global account id.
        let accountId = args.id;
        if (!accountId) {
          let lookup = sb.from("accounts").select("id");
          if (args.linkedin_handle) {
            lookup = lookup.eq("linkedin_handle", args.linkedin_handle.toLowerCase());
          } else if (args.profile_url) {
            const url = normalizeProfileUrl(args.profile_url);
            if (!url) return errorContent("Invalid LinkedIn profile URL.");
            lookup = lookup.eq("profile_url", url);
          }
          const { data: hit, error: lookupErr } = await lookup.maybeSingle();
          if (lookupErr) return errorContent(lookupErr.message);
          if (!hit) return errorContent("No matching account found.");
          accountId = hit.id;
        }

        const newNiche = args.niche === null ? null : args.niche.trim() || null;
        const { data, error } = await sb
          .from("workspace_accounts")
          .update({ niche: newNiche })
          .eq("workspace_id", workspaceId)
          .eq("account_id", accountId)
          .select(
            "niche, added_at, accounts!inner(id, name, linkedin_handle, profile_url, niche, source, synced_at, archived_at)",
          )
          .maybeSingle();
        if (error) return errorContent(error.message);
        if (!data) {
          return errorContent(
            "Account isn't tracked by this workspace. Use add_account first.",
          );
        }
        const acc = Array.isArray(data.accounts) ? data.accounts[0] : data.accounts;
        return jsonContent({
          ok: true,
          account: {
            ...acc,
            workspace_niche: data.niche,
            effective_niche: data.niche ?? acc?.niche ?? null,
          },
        });
      } catch (e) {
        return errorContent((e as Error).message);
      }
    },
  );

  server.registerTool(
    "remove_account",
    {
      title: "Stop tracking an account for this workspace",
      description:
        "Untrack an account from this workspace (deletes the workspace_accounts row). The global catalog row is preserved — other workspaces tracking the same creator are unaffected, and re-tracking later keeps the historical scrapes.",
      inputSchema: {
        id: z.string().uuid().optional(),
        linkedin_handle: z.string().optional(),
        profile_url: z.string().optional(),
      },
    },
    async (args, extra) => {
      try {
        const workspaceId = workspaceFromExtra(extra);
        if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
        const idents = [args.id, args.linkedin_handle, args.profile_url].filter(Boolean);
        if (idents.length !== 1) {
          return errorContent("Provide exactly one of: id, linkedin_handle, profile_url.");
        }
        const sb = supabaseAdmin();

        let accountId = args.id;
        if (!accountId) {
          let lookup = sb.from("accounts").select("id, name, linkedin_handle");
          if (args.linkedin_handle) {
            lookup = lookup.eq("linkedin_handle", args.linkedin_handle.toLowerCase());
          } else if (args.profile_url) {
            const url = normalizeProfileUrl(args.profile_url);
            if (!url) return errorContent("Invalid LinkedIn profile URL.");
            lookup = lookup.eq("profile_url", url);
          }
          const { data: hit, error: lookupErr } = await lookup.maybeSingle();
          if (lookupErr) return errorContent(lookupErr.message);
          if (!hit) return errorContent("No matching account found.");
          accountId = hit.id;
        }

        const { data, error } = await sb
          .from("workspace_accounts")
          .delete()
          .eq("workspace_id", workspaceId)
          .eq("account_id", accountId)
          .select("account_id")
          .maybeSingle();
        if (error) return errorContent(error.message);
        if (!data) return errorContent("Account wasn't tracked by this workspace.");
        return jsonContent({ ok: true, untracked_account_id: data.account_id });
      } catch (e) {
        return errorContent((e as Error).message);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Read-only: branding (workspace-scoped brand profiles — colors, logo, fonts)
  // Mirrors the `clients` table internally but exposed as "brand" terminology
  // through MCP so prompts read naturally.
  // -------------------------------------------------------------------------

  const BRAND_COLS =
    "id, name, brand_colors, notes, logo_url, font_primary, font_secondary, created_at";

  server.registerTool(
    "list_brands",
    {
      title: "List brands in this workspace",
      description:
        "List every brand stored in this workspace, with colors, logo URL, fonts, and notes. Useful for multi-brand operators who want to render the same concept across several brands.",
      inputSchema: {},
    },
    async (_args, extra) => {
      try {
        const workspaceId = workspaceFromExtra(extra);
        if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
        const sb = supabaseAdmin();
        const { data, error } = await sb
          .from("clients")
          .select(BRAND_COLS)
          .eq("workspace_id", workspaceId)
          .order("created_at", { ascending: false });
        if (error) return errorContent(error.message);
        return jsonContent({ ok: true, count: data?.length ?? 0, brands: data ?? [] });
      } catch (e) {
        return errorContent((e as Error).message);
      }
    },
  );

  server.registerTool(
    "get_brand",
    {
      title: "Get a brand by name or id",
      description:
        "Fetch a single brand profile. Provide either `name` (case-insensitive exact match) or `id`. Returns brand_colors (hex palette), logo_url, font_primary, font_secondary, and notes — everything Claude needs to write an on-brand image prompt or copy.",
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe("Exact brand name, case-insensitive. e.g. 'Acme'."),
        id: z.string().uuid().optional().describe("Brand UUID."),
      },
    },
    async (args, extra) => {
      try {
        const workspaceId = workspaceFromExtra(extra);
        if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
        const idents = [args.name, args.id].filter(Boolean);
        if (idents.length !== 1) {
          return errorContent("Provide exactly one of: name, id.");
        }
        const sb = supabaseAdmin();
        let q = sb
          .from("clients")
          .select(BRAND_COLS)
          .eq("workspace_id", workspaceId)
          .limit(1);
        if (args.id) {
          q = q.eq("id", args.id);
        } else if (args.name) {
          q = q.ilike("name", args.name);
        }
        const { data, error } = await q.maybeSingle();
        if (error) return errorContent(error.message);
        if (!data) return errorContent("No matching brand found.");
        return jsonContent({ ok: true, brand: data });
      } catch (e) {
        return errorContent((e as Error).message);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Read-only: voice profile (one per workspace — the user's own writing voice,
  // synthesized from their last ~50 LinkedIn posts in the Voice tab). Distinct
  // from `get_brand` (per-client visual brand). Draft-generation prompts read
  // this so AI-written content actually sounds like the user.
  // -------------------------------------------------------------------------

  server.registerTool(
    "get_voice",
    {
      title: "Get this workspace's voice profile",
      description:
        "Fetch the workspace owner's writing-voice profile, synthesized from their recent LinkedIn posts. Returns a structured profile: a plain-English summary, target audience (pain points + outcomes), topics, positioning, tone, format patterns (hook styles, structure, length), signature moves, do/don't lists, and 2-3 verbatim exemplar posts. Read this before drafting any post in the user's voice. Returns ok:false when no voice has been generated yet.",
      inputSchema: {},
    },
    async (_args, extra) => {
      try {
        const workspaceId = workspaceFromExtra(extra);
        if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
        const sb = supabaseAdmin();
        const { data, error } = await sb
          .from("voice_profiles")
          .select(
            "linkedin_handle, display_name, headline, profile, summary, source_post_count, status, model, generated_at",
          )
          .eq("workspace_id", workspaceId)
          .maybeSingle();
        if (error) return errorContent(error.message);
        if (!data || data.status !== "ready" || !data.profile) {
          return jsonContent({
            ok: false,
            error:
              "No voice profile yet. Ask the user to generate one in the Voice tab (paste their LinkedIn profile URL).",
            status: data?.status ?? null,
          });
        }
        return jsonContent({
          ok: true,
          voice: {
            linkedin_handle: data.linkedin_handle,
            display_name: data.display_name,
            headline: data.headline,
            summary: data.summary,
            profile: data.profile,
            source_post_count: data.source_post_count,
            model: data.model,
            generated_at: data.generated_at,
          },
        });
      } catch (e) {
        return errorContent((e as Error).message);
      }
    },
  );

  server.registerTool(
    "restore_account",
    {
      title: "Re-track a previously untracked account",
      description:
        "Re-insert this workspace's tracking row for an account in the global catalog. Equivalent to add_account but resolves a known account id/handle/url without supplying a name.",
      inputSchema: {
        id: z.string().uuid().optional(),
        linkedin_handle: z.string().optional(),
        profile_url: z.string().optional(),
      },
    },
    async (args, extra) => {
      try {
        const workspaceId = workspaceFromExtra(extra);
        if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
        const idents = [args.id, args.linkedin_handle, args.profile_url].filter(Boolean);
        if (idents.length !== 1) {
          return errorContent("Provide exactly one of: id, linkedin_handle, profile_url.");
        }
        const sb = supabaseAdmin();

        let lookup = sb.from("accounts").select(
          "id, name, linkedin_handle, profile_url, niche, source, synced_at, archived_at",
        );
        if (args.id) lookup = lookup.eq("id", args.id);
        else if (args.linkedin_handle) {
          lookup = lookup.eq("linkedin_handle", args.linkedin_handle.toLowerCase());
        } else if (args.profile_url) {
          const url = normalizeProfileUrl(args.profile_url);
          if (!url) return errorContent("Invalid LinkedIn profile URL.");
          lookup = lookup.eq("profile_url", url);
        }
        const { data: acc, error: lookupErr } = await lookup.maybeSingle();
        if (lookupErr) return errorContent(lookupErr.message);
        if (!acc) return errorContent("No matching account found.");

        const { error: trackErr } = await sb.from("workspace_accounts").upsert(
          { workspace_id: workspaceId, account_id: acc.id, niche: null },
          { onConflict: "workspace_id,account_id" },
        );
        if (trackErr) return errorContent(trackErr.message);

        return jsonContent({
          ok: true,
          account: { ...acc, workspace_niche: null, effective_niche: acc.niche },
        });
      } catch (e) {
        return errorContent((e as Error).message);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Saved (bookmarked) posts — workspace-scoped, free oEmbed enrichment
  // ---------------------------------------------------------------------------

  server.registerTool(
    "save_post",
    {
      title: "Bookmark a LinkedIn post",
      description:
        "Bookmark a LinkedIn post to this workspace's Bookmarks library by URL. Accepts both the /feed/update/urn:li:activity:.../ and /posts/handle_keywords-id-suffix shapes. We don't scrape engagement — just store the URL, author, and a short text preview from oEmbed. Idempotent: re-saving the same post is a no-op. Bookmarks live on a separate dashboard tab from the scraped Swipe File feed.",
      inputSchema: {
        url: z
          .string()
          .url()
          .describe("LinkedIn post URL — either /feed/update/... or /posts/..."),
        note: z.string().optional().describe("Optional note to attach to the bookmark."),
        category: z
          .string()
          .optional()
          .describe(
            "Optional niche tag — one of the curated category ids (e.g. 'linkedin', 'ai', 'outreach'). Invalid values are silently dropped.",
          ),
      },
    },
    async (args, extra) => {
      try {
        const workspaceId = workspaceFromExtra(extra);
        if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);

        const urn = extractUrnFromUrl(args.url);
        if (!urn) {
          return errorContent(
            "Couldn't read that URL. Paste a LinkedIn post link — /feed/update/urn:li:activity:... or /posts/...",
          );
        }
        const activityId = urn.id;

        const sb = supabaseAdmin();
        const canonical = canonicalPostUrl(activityId);
        const handleFromUrl = authorHandleFromUrl(args.url);

        const { data: existing } = await sb
          .from("saved_posts")
          .select(
            "id, post_url, activity_id, embed_urn, author_name, author_handle, text_snippet, note, category_id, saved_at",
          )
          .eq("workspace_id", workspaceId)
          .eq("activity_id", activityId)
          .maybeSingle();
        if (existing) {
          return jsonContent({ ok: true, alreadySaved: true, saved: existing });
        }

        // Validate the optional category against the curated taxonomy.
        // FK violation here would crash the save with a 23503 instead of a
        // helpful "invalid category" message, so we drop unknown values
        // silently — the user's note still gets persisted.
        let categoryId: string | null = null;
        const rawCategory = args.category?.trim();
        if (rawCategory) {
          const { data: catRow } = await sb
            .from("categories")
            .select("id")
            .eq("id", rawCategory)
            .maybeSingle();
          categoryId = catRow?.id ?? null;
        }

        const [oembed, probedUrn] = await Promise.all([
          fetchOEmbed(canonical),
          probeEmbedUrn(activityId),
        ]);
        // See app/api/saved-posts/route.ts for the same fallback chain: URL
        // slug → oEmbed author_url → follow-redirects on the canonical URL.
        let handle = handleFromUrl;
        if (!handle && oembed.authorProfileUrl) {
          handle = authorHandleFromProfileUrl(oembed.authorProfileUrl);
        }
        if (!handle) {
          handle = await fetchHandleViaRedirect(canonical);
        }
        const authorName =
          oembed.authorName ?? (handle ? displayNameFromHandle(handle) : null);

        const { data: inserted, error } = await sb
          .from("saved_posts")
          .insert({
            workspace_id: workspaceId,
            activity_id: activityId,
            // Prefer a URL built from the verified embed URN (correct type,
            // known to resolve); else build from the parsed URN type. Avoids
            // the old activity-shaped guess that 404s for share/ugcPost posts.
            post_url:
              postUrlFromUrn(oembed.embedUrn ?? probedUrn) ??
              postUrlForUrn(urn.type, activityId),
            original_url: args.url,
            author_name: authorName,
            author_handle: handle,
            text_snippet: oembed.textSnippet,
            // Store null if both oEmbed and probe failed — see API route
            // comment. The URL-shape guess (urn:li:${urn.type}:${urn.id}) is
            // unreliable and most likely 404s.
            embed_urn: oembed.embedUrn ?? probedUrn ?? null,
            note: args.note ?? null,
            category_id: categoryId,
          })
          .select(
            "id, post_url, activity_id, embed_urn, author_name, author_handle, text_snippet, note, category_id, saved_at",
          )
          .single();
        if (error || !inserted) {
          if (error?.code === "23505") {
            const { data: row } = await sb
              .from("saved_posts")
              .select(
                "id, post_url, activity_id, embed_urn, author_name, author_handle, text_snippet, note, category_id, saved_at",
              )
              .eq("workspace_id", workspaceId)
              .eq("activity_id", activityId)
              .maybeSingle();
            if (row) return jsonContent({ ok: true, alreadySaved: true, saved: row });
          }
          return errorContent(error?.message ?? "insert failed");
        }

        return jsonContent({ ok: true, alreadySaved: false, saved: inserted });
      } catch (e) {
        return errorContent((e as Error).message);
      }
    },
  );

  server.registerTool(
    "list_saved_posts",
    {
      title: "List saved posts",
      description:
        "Return the workspace's bookmarked LinkedIn posts, newest-first. Use this to surface inspiration the team has manually collected (not part of the daily scrape).",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Default 20, max 100."),
      },
    },
    async (args, extra) => {
      try {
        const workspaceId = workspaceFromExtra(extra);
        if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
        const sb = supabaseAdmin();
        const limit = args.limit ?? 20;
        const { data, error } = await sb
          .from("saved_posts")
          .select(
            "id, post_url, activity_id, embed_urn, author_name, author_handle, text_snippet, note, category_id, saved_at",
          )
          .eq("workspace_id", workspaceId)
          .order("saved_at", { ascending: false })
          .limit(limit);
        if (error) return errorContent(error.message);
        return jsonContent({ ok: true, count: (data ?? []).length, saved: data ?? [] });
      } catch (e) {
        return errorContent((e as Error).message);
      }
    },
  );
}
