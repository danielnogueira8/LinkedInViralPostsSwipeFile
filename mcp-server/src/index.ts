#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { supabase } from "./supabase.js";
import {
  errorContent,
  handleFromUrl,
  jsonContent,
  normalizeProfileUrl,
  parseDayEnd,
  parseDayStart,
  sinceCutoff,
} from "./util.js";

const POST_TYPES = ["regular", "lead_magnet"] as const;
const SORT_COLUMN = {
  viral: "viral_score",
  reactions: "reactions",
  comments: "comments",
  posted: "posted_at",
} as const;

const POST_COLS =
  "id, text, post_url, posted_at, reactions, comments, reposts, media_type, media_urls, visual_kind, scraped_at, post_type, is_viral, accounts!inner(id, name, niche, linkedin_handle, profile_pic_url), templates(id, template_text)";

// "Top from the latest scrape" = best posts PUBLISHED in this many days before
// the most recent scrape run (kept in sync with the web app's lib/agent/tools.ts).
const TOP_BATCH_WINDOW_DAYS = 30;

function normalizeEmbed<T extends { accounts: unknown }>(p: T) {
  return {
    ...p,
    accounts: Array.isArray(p.accounts) ? (p.accounts[0] ?? null) : p.accounts,
  };
}

const server = new McpServer({
  name: "linkedin-swipe-mcp",
  version: "0.1.0",
});

// ---------------------------------------------------------------------------
// Read-only: swipe file
// ---------------------------------------------------------------------------

server.registerTool(
  "search_viral_posts",
  {
    title: "Search viral posts",
    description:
      "Search the viral swipe file. Filter by niche, date range, engagement thresholds, and post type. Returns top matching posts with author info.",
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
  async (args) => {
    try {
      const sb = supabase();
      const sortKey = args.sort ?? "viral";
      const sortCol = SORT_COLUMN[sortKey];
      const ascending = args.dir === "asc";
      const limit = args.limit ?? 10;

      let q = sb
        .from("posts")
        .select(POST_COLS)
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
    description: "Fetch a single post by id, including the generated template if one exists.",
    inputSchema: {
      id: z.string().uuid().describe("Post UUID."),
    },
  },
  async ({ id }) => {
    try {
      const sb = supabase();
      const { data, error } = await sb
        .from("posts")
        .select(POST_COLS)
        .eq("id", id)
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
    description: "List all niches across active (non-archived) tracked accounts, with counts.",
    inputSchema: {},
  },
  async () => {
    try {
      const sb = supabase();
      const { data, error } = await sb
        .from("accounts")
        .select("niche")
        .is("archived_at", null);
      if (error) return errorContent(error.message);
      const counts = new Map<string, number>();
      for (const row of data ?? []) {
        const n = (row as { niche: string | null }).niche;
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
    title: "Get top recently-published posts as of the most recent scrape",
    description:
      "Returns the highest-engagement RECENTLY-PUBLISHED posts (last ~30 days before the most recent scrape). Filtered by publish date, not scrape date — a scrape re-ingests old posts too. The result's `scrape.scraped_at` is the real scrape date; each post carries its own `posted_at`.",
    inputSchema: {
      limit: z.number().int().min(1).max(20).optional().describe("Default 5, max 20."),
    },
  },
  async ({ limit }) => {
    try {
      const sb = supabase();
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
      // Filter by PUBLISH date, not scrape date: a scrape re-ingests each
      // creator's recent history, so scraped_at is the run date even for old
      // posts. Window = the N days before the scrape (see the web app's
      // lib/agent/tools.ts — kept in sync).
      const runStartMs = new Date(lastRun.started_at as string).getTime();
      const sinceIso = new Date(
        runStartMs - TOP_BATCH_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
      const { data, error } = await sb
        .from("posts")
        .select(POST_COLS)
        .eq("is_viral", true)
        .is("accounts.archived_at", null)
        .gte("posted_at", sinceIso)
        .order("reactions", { ascending: false, nullsFirst: false })
        .limit(limit ?? 5);
      if (error) return errorContent(error.message);
      return jsonContent({
        ok: true,
        scrape: {
          scraped_at: lastRun.finished_at ?? lastRun.started_at,
          posts_published_since: sinceIso,
          window_days: TOP_BATCH_WINDOW_DAYS,
        },
        count: data?.length ?? 0,
        posts: (data ?? []).map(normalizeEmbed),
      });
    } catch (e) {
      return errorContent((e as Error).message);
    }
  },
);

// ---------------------------------------------------------------------------
// Read/write: accounts
// ---------------------------------------------------------------------------

server.registerTool(
  "list_accounts",
  {
    title: "List tracked accounts",
    description: "List tracked accounts, optionally filtered by niche or name/handle search.",
    inputSchema: {
      niche: z.string().optional(),
      search: z.string().optional().describe("Case-insensitive substring match on name or handle."),
      include_archived: z.boolean().optional().describe("Default false."),
      limit: z.number().int().min(1).max(200).optional().describe("Default 50, max 200."),
    },
  },
  async (args) => {
    try {
      const sb = supabase();
      let q = sb
        .from("accounts")
        .select("id, name, linkedin_handle, profile_url, niche, source, synced_at, archived_at")
        .order("name", { ascending: true })
        .limit(args.limit ?? 50);
      if (!args.include_archived) q = q.is("archived_at", null);
      if (args.niche) q = q.eq("niche", args.niche);
      if (args.search) {
        const s = args.search.replace(/[%_]/g, "");
        q = q.or(`name.ilike.%${s}%,linkedin_handle.ilike.%${s}%`);
      }
      const { data, error } = await q;
      if (error) return errorContent(error.message);
      return jsonContent({ ok: true, count: data?.length ?? 0, accounts: data ?? [] });
    } catch (e) {
      return errorContent((e as Error).message);
    }
  },
);

server.registerTool(
  "add_account",
  {
    title: "Add a tracked account",
    description:
      "Add a LinkedIn profile to the tracked accounts. Idempotent on profile_url — re-adding the same handle updates name/niche and un-archives if it was archived. New niches are accepted without validation.",
    inputSchema: {
      profile_url: z
        .string()
        .describe("Any linkedin.com/in/<handle> URL. Normalized server-side."),
      name: z.string().min(1).describe("Display name for the account."),
      niche: z.string().optional().describe("Free-form niche label, e.g. 'AI', 'SaaS'."),
    },
  },
  async ({ profile_url, name, niche }) => {
    try {
      const url = normalizeProfileUrl(profile_url);
      if (!url) return errorContent("Invalid LinkedIn profile URL.");
      const sb = supabase();
      const { data, error } = await sb
        .from("accounts")
        .upsert(
          {
            name: name.trim(),
            profile_url: url,
            linkedin_handle: handleFromUrl(url),
            niche: niche?.trim() || null,
            source: "manual",
            synced_at: new Date().toISOString(),
            archived_at: null,
          },
          { onConflict: "profile_url" },
        )
        .select("id, name, linkedin_handle, profile_url, niche, source, synced_at, archived_at")
        .single();
      if (error) return errorContent(error.message);
      return jsonContent({ ok: true, account: data });
    } catch (e) {
      return errorContent((e as Error).message);
    }
  },
);

server.registerTool(
  "update_account",
  {
    title: "Update a tracked account",
    description:
      "Update name and/or niche on an existing account. Identify the account by id, linkedin_handle, or profile_url (exactly one required).",
    inputSchema: {
      id: z.string().uuid().optional(),
      linkedin_handle: z.string().optional(),
      profile_url: z.string().optional(),
      name: z.string().min(1).optional(),
      niche: z.string().nullable().optional().describe("Pass null to clear (note: a DB trigger may protect against clearing niche)."),
    },
  },
  async (args) => {
    try {
      const idents = [args.id, args.linkedin_handle, args.profile_url].filter(Boolean);
      if (idents.length !== 1) {
        return errorContent("Provide exactly one of: id, linkedin_handle, profile_url.");
      }
      if (args.name === undefined && args.niche === undefined) {
        return errorContent("Provide at least one of: name, niche.");
      }
      const sb = supabase();
      const patch: Record<string, unknown> = { synced_at: new Date().toISOString() };
      if (args.name !== undefined) patch.name = args.name.trim();
      if (args.niche !== undefined) patch.niche = args.niche === null ? null : args.niche.trim() || null;

      let q = sb.from("accounts").update(patch);
      if (args.id) q = q.eq("id", args.id);
      else if (args.linkedin_handle) q = q.eq("linkedin_handle", args.linkedin_handle.toLowerCase());
      else if (args.profile_url) {
        const url = normalizeProfileUrl(args.profile_url);
        if (!url) return errorContent("Invalid LinkedIn profile URL.");
        q = q.eq("profile_url", url);
      }
      const { data, error } = await q
        .select("id, name, linkedin_handle, profile_url, niche, source, synced_at, archived_at")
        .maybeSingle();
      if (error) return errorContent(error.message);
      if (!data) return errorContent("No matching account found.");
      return jsonContent({ ok: true, account: data });
    } catch (e) {
      return errorContent((e as Error).message);
    }
  },
);

server.registerTool(
  "remove_account",
  {
    title: "Archive (soft-delete) a tracked account",
    description:
      "Soft-delete an account by setting archived_at. Hidden from future swipe results and listings, but historical posts remain in the DB. Identify by id, linkedin_handle, or profile_url.",
    inputSchema: {
      id: z.string().uuid().optional(),
      linkedin_handle: z.string().optional(),
      profile_url: z.string().optional(),
    },
  },
  async (args) => {
    try {
      const idents = [args.id, args.linkedin_handle, args.profile_url].filter(Boolean);
      if (idents.length !== 1) {
        return errorContent("Provide exactly one of: id, linkedin_handle, profile_url.");
      }
      const sb = supabase();
      let q = sb.from("accounts").update({ archived_at: new Date().toISOString() });
      if (args.id) q = q.eq("id", args.id);
      else if (args.linkedin_handle) q = q.eq("linkedin_handle", args.linkedin_handle.toLowerCase());
      else if (args.profile_url) {
        const url = normalizeProfileUrl(args.profile_url);
        if (!url) return errorContent("Invalid LinkedIn profile URL.");
        q = q.eq("profile_url", url);
      }
      const { data, error } = await q
        .select("id, name, linkedin_handle, archived_at")
        .maybeSingle();
      if (error) return errorContent(error.message);
      if (!data) return errorContent("No matching account found.");
      return jsonContent({ ok: true, account: data });
    } catch (e) {
      return errorContent((e as Error).message);
    }
  },
);

server.registerTool(
  "restore_account",
  {
    title: "Restore an archived account",
    description: "Clear archived_at on an account so it shows up in swipe results again.",
    inputSchema: {
      id: z.string().uuid().optional(),
      linkedin_handle: z.string().optional(),
      profile_url: z.string().optional(),
    },
  },
  async (args) => {
    try {
      const idents = [args.id, args.linkedin_handle, args.profile_url].filter(Boolean);
      if (idents.length !== 1) {
        return errorContent("Provide exactly one of: id, linkedin_handle, profile_url.");
      }
      const sb = supabase();
      let q = sb.from("accounts").update({ archived_at: null });
      if (args.id) q = q.eq("id", args.id);
      else if (args.linkedin_handle) q = q.eq("linkedin_handle", args.linkedin_handle.toLowerCase());
      else if (args.profile_url) {
        const url = normalizeProfileUrl(args.profile_url);
        if (!url) return errorContent("Invalid LinkedIn profile URL.");
        q = q.eq("profile_url", url);
      }
      const { data, error } = await q
        .select("id, name, linkedin_handle, archived_at")
        .maybeSingle();
      if (error) return errorContent(error.message);
      if (!data) return errorContent("No matching account found.");
      return jsonContent({ ok: true, account: data });
    } catch (e) {
      return errorContent((e as Error).message);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
