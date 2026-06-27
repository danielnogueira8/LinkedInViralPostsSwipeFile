import { supabaseAdmin } from "@/lib/supabase";
import { trackedAccountIds } from "@/lib/supabase-scoped";
import { parseDayStart, parseDayEnd, sinceCutoff } from "@/lib/mcp/util";
import type { ToolDef } from "@/lib/openrouter";

// ---------------------------------------------------------------------------
// Agent tools — read-only swipe-file / voice / brand access for the chat agent.
//
// These mirror the read-only handlers in lib/mcp/register.ts (same queries,
// same workspace scoping) but as plain (args, workspaceId) => result functions
// the GLM-5.1 tool-calling loop can dispatch directly, plus their OpenAI-format
// tool definitions. Write/mutation tools are intentionally NOT exposed here in
// v1 — the chat can read the swipe file and draft, but not modify accounts.
//
// Kept deliberately close to register.ts so the two don't drift: same POST_COLS,
// same filters, same normalizeEmbed. If the MCP query logic changes, mirror it
// here.
// ---------------------------------------------------------------------------

const POST_TYPES = ["regular", "lead_magnet"] as const;
const SORT_COLUMN = {
  viral: "viral_score",
  reactions: "reactions",
  comments: "comments",
  posted: "posted_at",
} as const;

const POST_COLS =
  "id, text, post_url, posted_at, reactions, comments, reposts, media_type, media_urls, visual_kind, scraped_at, post_type, is_viral, account_id, accounts!inner(id, name, niche, linkedin_handle, profile_pic_url), templates(id, template_text)";

const BRAND_COLS =
  "id, name, brand_colors, notes, logo_url, font_primary, font_secondary, created_at";

// Sentinel UUID that matches no rows, used so an `.in("account_id", [])` never
// degenerates into "no filter" (which would leak other workspaces' posts).
const NO_ROWS_SENTINEL = "00000000-0000-0000-0000-000000000000";

function normalizeEmbed<T extends { accounts: unknown }>(p: T) {
  return {
    ...p,
    accounts: Array.isArray(p.accounts) ? (p.accounts[0] ?? null) : p.accounts,
  };
}

// All tool fns return a plain JSON-able object. On failure they return
// { ok: false, error } rather than throwing, so a tool error becomes a tool
// message the model can read and recover from (e.g. "no voice profile yet")
// instead of aborting the whole turn.
export type ToolResult = Record<string, unknown>;

type ToolFn = (
  args: Record<string, unknown>,
  workspaceId: string,
) => Promise<ToolResult>;

function err(message: string): ToolResult {
  return { ok: false, error: message };
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

const searchViralPosts: ToolFn = async (args, workspaceId) => {
  try {
    const accountIds = await trackedAccountIds(workspaceId);
    const sb = supabaseAdmin();
    const sortKey = (args.sort as keyof typeof SORT_COLUMN) ?? "viral";
    const sortCol = SORT_COLUMN[sortKey] ?? SORT_COLUMN.viral;
    const ascending = args.dir === "asc";
    const limit = typeof args.limit === "number" ? args.limit : 10;

    let q = sb
      .from("posts")
      .select(POST_COLS)
      .in("account_id", accountIds.length ? accountIds : [NO_ROWS_SENTINEL])
      .eq("is_viral", true)
      .is("accounts.archived_at", null)
      .order(sortCol, { ascending, nullsFirst: false })
      .limit(Math.min(Math.max(limit, 1), 50));

    if (args.niche) q = q.eq("accounts.niche", args.niche as string);
    const sinceIso = sinceCutoff(args.since as string | undefined);
    const fromIso = parseDayStart(args.from as string | undefined);
    const toIso = parseDayEnd(args.to as string | undefined);
    if (sinceIso) q = q.gte("posted_at", sinceIso);
    if (fromIso) q = q.gte("posted_at", fromIso);
    if (toIso) q = q.lte("posted_at", toIso);
    if (typeof args.min_reactions === "number")
      q = q.gte("reactions", args.min_reactions);
    if (typeof args.min_comments === "number")
      q = q.gte("comments", args.min_comments);
    if (args.post_type) q = q.eq("post_type", args.post_type as string);

    const { data, error } = await q;
    if (error) return err(error.message);
    const posts = (data ?? []).map(normalizeEmbed);
    return { ok: true, count: posts.length, posts };
  } catch (e) {
    return err((e as Error).message);
  }
};

const getPost: ToolFn = async (args, workspaceId) => {
  try {
    const id = args.id as string;
    const accountIds = await trackedAccountIds(workspaceId);
    if (accountIds.length === 0) return err(`No post found with id ${id}`);
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("posts")
      .select(POST_COLS)
      .eq("id", id)
      .in("account_id", accountIds)
      .maybeSingle();
    if (error) return err(error.message);
    if (!data) return err(`No post found with id ${id}`);
    return { ok: true, post: normalizeEmbed(data) };
  } catch (e) {
    return err((e as Error).message);
  }
};

const listNiches: ToolFn = async (_args, workspaceId) => {
  try {
    const accountIds = await trackedAccountIds(workspaceId);
    if (accountIds.length === 0) return { ok: true, niches: [] };
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("workspace_accounts")
      .select("niche, accounts!inner(niche, archived_at)")
      .eq("workspace_id", workspaceId)
      .is("accounts.archived_at", null);
    if (error) return err(error.message);

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
    return { ok: true, niches };
  } catch (e) {
    return err((e as Error).message);
  }
};

// "What's working right now." Anchored to the most recent successful scrape run
// (so we can tell the user the real scrape date), but filtered by when posts
// were PUBLISHED — not when they were scraped. A scrape re-ingests each
// creator's recent history, so `scraped_at` is the run date even for a month-old
// post; ranking those by accumulated engagement surfaces stale posts as if they
// were new (a month-old post has had longer to collect reactions/comments).
// Filtering on `posted_at` within a recent window answers the real question:
// the best RECENTLY-PUBLISHED posts as of the latest scrape.
const TOP_BATCH_WINDOW_DAYS = 30;

const getTopFromBatch: ToolFn = async (args, workspaceId) => {
  try {
    const accountIds = await trackedAccountIds(workspaceId);
    if (accountIds.length === 0)
      return { ok: true, posts: [], note: "Workspace tracks no accounts." };
    const sb = supabaseAdmin();
    const { data: lastRun, error: runErr } = await sb
      .from("runs")
      .select("started_at, finished_at")
      .eq("status", "ok")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (runErr) return err(runErr.message);
    if (!lastRun?.started_at)
      return { ok: true, posts: [], note: "No successful scrape run found yet." };
    const limit = typeof args.limit === "number" ? args.limit : 5;
    // Recency window: posts published in the N days leading up to the latest
    // scrape. Measured from the run's start so "recent" is relative to when the
    // data was captured, not to "now" (which could be days later).
    const runStartMs = new Date(lastRun.started_at as string).getTime();
    const sinceIso = new Date(
      runStartMs - TOP_BATCH_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const { data, error } = await sb
      .from("posts")
      .select(POST_COLS)
      .in("account_id", accountIds)
      .eq("is_viral", true)
      .is("accounts.archived_at", null)
      .gte("posted_at", sinceIso)
      .order("reactions", { ascending: false, nullsFirst: false })
      .limit(Math.min(Math.max(limit, 1), 20));
    if (error) return err(error.message);
    return {
      ok: true,
      // Surface the dates so the model can state them honestly: the scrape date
      // (when the data was captured) and the publish window the posts fall in.
      scrape: {
        scraped_at: lastRun.finished_at ?? lastRun.started_at,
        posts_published_since: sinceIso,
        window_days: TOP_BATCH_WINDOW_DAYS,
      },
      count: data?.length ?? 0,
      posts: (data ?? []).map(normalizeEmbed),
    };
  } catch (e) {
    return err((e as Error).message);
  }
};

const getVoice: ToolFn = async (_args, workspaceId) => {
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("voice_profiles")
      .select(
        "linkedin_handle, display_name, headline, profile, summary, source_post_count, status, model, generated_at",
      )
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (error) return err(error.message);
    if (!data || data.status !== "ready" || !data.profile) {
      return {
        ok: false,
        error:
          "No voice profile yet. Ask the user to generate one in the Voice tab (paste their LinkedIn profile URL).",
        status: data?.status ?? null,
      };
    }
    return {
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
    };
  } catch (e) {
    return err((e as Error).message);
  }
};

const listAccounts: ToolFn = async (args, workspaceId) => {
  try {
    const sb = supabaseAdmin();
    let q = sb
      .from("workspace_accounts")
      .select(
        "niche, added_at, accounts!inner(id, name, linkedin_handle, profile_url, niche, source, synced_at, archived_at)",
      )
      .eq("workspace_id", workspaceId)
      .order("name", { foreignTable: "accounts", ascending: true })
      .limit(typeof args.limit === "number" ? Math.min(args.limit, 200) : 50);

    if (!args.include_archived) q = q.is("accounts.archived_at", null);
    if (args.niche) {
      const n = args.niche as string;
      q = q.or(`niche.eq.${n},and(niche.is.null,accounts.niche.eq.${n})`);
    }
    if (args.search) {
      const s = (args.search as string).replace(/[%_]/g, "");
      q = q.or(`name.ilike.%${s}%,linkedin_handle.ilike.%${s}%`, {
        foreignTable: "accounts",
      });
    }
    const { data, error } = await q;
    if (error) return err(error.message);

    const accounts = ((data ?? []) as Array<{
      niche: string | null;
      added_at: string;
      accounts: Record<string, unknown> | Record<string, unknown>[];
    }>).map((r) => {
      const acc = Array.isArray(r.accounts) ? r.accounts[0] : r.accounts;
      return {
        ...acc,
        workspace_niche: r.niche,
        effective_niche: r.niche ?? (acc?.niche as string | null) ?? null,
        tracked_at: r.added_at,
      };
    });
    return { ok: true, count: accounts.length, accounts };
  } catch (e) {
    return err((e as Error).message);
  }
};

const listBrands: ToolFn = async (_args, workspaceId) => {
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("clients")
      .select(BRAND_COLS)
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false });
    if (error) return err(error.message);
    return { ok: true, count: data?.length ?? 0, brands: data ?? [] };
  } catch (e) {
    return err((e as Error).message);
  }
};

const getBrand: ToolFn = async (args, workspaceId) => {
  try {
    const idents = [args.name, args.id].filter(Boolean);
    if (idents.length !== 1) return err("Provide exactly one of: name, id.");
    const sb = supabaseAdmin();
    let q = sb
      .from("clients")
      .select(BRAND_COLS)
      .eq("workspace_id", workspaceId)
      .limit(1);
    if (args.id) q = q.eq("id", args.id as string);
    else if (args.name) q = q.ilike("name", args.name as string);
    const { data, error } = await q.maybeSingle();
    if (error) return err(error.message);
    if (!data) return err("No matching brand found.");
    return { ok: true, brand: data };
  } catch (e) {
    return err((e as Error).message);
  }
};

// ---------------------------------------------------------------------------
// Registry: name -> fn, plus the OpenAI tool definitions sent to GLM-5.1.
// ---------------------------------------------------------------------------

export const TOOL_FNS: Record<string, ToolFn> = {
  search_viral_posts: searchViralPosts,
  get_post: getPost,
  list_niches: listNiches,
  get_top_from_batch: getTopFromBatch,
  get_voice: getVoice,
  list_accounts: listAccounts,
  list_brands: listBrands,
  get_brand: getBrand,
};

export const TOOL_DEFS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "search_viral_posts",
      description:
        "Search the workspace's viral swipe file (posts from the accounts this workspace tracks). Filter by niche, date range, engagement, and post type. Use this to find proven viral posts to mimic or to inform original drafts.",
      parameters: {
        type: "object",
        properties: {
          niche: { type: "string", description: "Exact account niche, e.g. 'AI', 'SaaS'." },
          since: {
            type: "string",
            enum: ["1d", "7d", "30d"],
            description: "Relative window: posts within the last 1, 7, or 30 days.",
          },
          from: { type: "string", description: "Lower bound on posted_at, YYYY-MM-DD." },
          to: { type: "string", description: "Upper bound on posted_at, YYYY-MM-DD." },
          min_reactions: { type: "integer", minimum: 0 },
          min_comments: { type: "integer", minimum: 0 },
          post_type: { type: "string", enum: [...POST_TYPES] },
          sort: {
            type: "string",
            enum: ["viral", "reactions", "comments", "posted"],
            description: "Sort key. Default 'viral'.",
          },
          dir: { type: "string", enum: ["asc", "desc"], description: "Default 'desc'." },
          limit: { type: "integer", minimum: 1, maximum: 50, description: "Default 10." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_post",
      description:
        "Fetch a single post by id (including its generated template if one exists). Only returns posts from accounts this workspace tracks.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Post UUID." } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_niches",
      description:
        "List niches across the workspace's tracked accounts, with post counts. Use to discover what content categories are available before searching.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_top_from_batch",
      description:
        "Get the highest-engagement RECENTLY-PUBLISHED posts as of the most recent scrape, for the workspace's tracked accounts. Good for 'what's working right now'. Posts are filtered by publish date (last ~30 days before the scrape), NOT by when they were scraped — a scrape re-ingests old posts too. The result's `scrape.scraped_at` is the real scrape date and each post carries its own `posted_at`; when you mention recency, cite the scrape date and never imply an older post is new.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 20, description: "Default 5." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_voice",
      description:
        "Fetch the workspace owner's writing-voice profile (summary, audience, tone, format patterns, signature moves, do/don't, and verbatim exemplar posts). ALWAYS call this before drafting any post in the user's voice. profile.lead_magnet_style (when present) is ONLY for promotional lead-magnet posts. Returns ok:false if no voice has been generated yet.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_accounts",
      description:
        "List the accounts this workspace tracks, optionally filtered by niche or a name/handle search.",
      parameters: {
        type: "object",
        properties: {
          niche: { type: "string" },
          search: { type: "string", description: "Substring match on name or handle." },
          include_archived: { type: "boolean", description: "Default false." },
          limit: { type: "integer", minimum: 1, maximum: 200, description: "Default 50." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_brands",
      description:
        "List every brand in this workspace (colors, logo, fonts, notes). Useful for multi-brand operators.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_brand",
      description:
        "Fetch a single brand by name (case-insensitive) or id — colors, logo, fonts, notes — for writing on-brand copy.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Exact brand name, case-insensitive." },
          id: { type: "string", description: "Brand UUID." },
        },
      },
    },
  },

  // -----------------------------------------------------------------------
  // Render-artifact tools — STRUCTURED OUTPUT pattern.
  //
  // These tools are NOT dispatched server-side (they're NOT in TOOL_FNS).
  // The agent loop intercepts calls to them and produces an artifact event
  // from the structured args. This replaces the legacy ```post / ```hook /
  // ```cite fenced-block protocol — emitting an artifact is now a TOOL CALL
  // with schema-validated args rather than free-form text the server has to
  // regex-parse. That makes a whole class of bugs structurally impossible:
  // empty-body cards, leaked raw fences, unclosed fences during streaming.
  //
  // See RENDER_TOOL_NAMES in lib/agent/run.ts.
  // -----------------------------------------------------------------------
  {
    type: "function",
    function: {
      name: "render_post",
      description:
        "Render a finished, publish-ready LinkedIn post as a draft card the user can copy, edit, or save. Use this for any final post you want the user to publish — do NOT put the post body in your chat reply. Conversational text (a brief intro or notes about the draft) still goes in your normal reply.",
      parameters: {
        type: "object",
        properties: {
          body: {
            type: "string",
            minLength: 1,
            description:
              "The full post text, with line breaks exactly as it should appear on LinkedIn. No commentary, no 'Here's your post:' framing.",
          },
        },
        required: ["body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "render_hook",
      description:
        "Render a single LinkedIn post hook (opener line(s) only) as a hook card the user can adapt. Call ONCE PER HOOK when the user asks for multiple — e.g. 5 hooks → 5 calls. Don't write the rest of the post; this is the opener only.",
      parameters: {
        type: "object",
        properties: {
          body: {
            type: "string",
            minLength: 1,
            description:
              "The hook text — opener line(s) only, exactly as it should appear. No 'Original:' / 'Yours:' labels, no commentary.",
          },
        },
        required: ["body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "render_cite",
      description:
        "Show the user a CARD for a specific swipe-file post you saw in a tool result (use when you reference a real post — 'the top lead-magnet post is from Ewan McAllister'). The card renders inline under your message. Use ONLY a post id you actually got back from search_viral_posts / get_post / get_top_from_batch — never invent one.",
      parameters: {
        type: "object",
        properties: {
          postId: {
            type: "string",
            description:
              "The post's id (UUID) exactly as returned by a swipe-file tool. Must be a real id from a tool result this turn — invented ids will not render.",
          },
        },
        required: ["postId"],
      },
    },
  },
  // ---------------------------------------------------------------------------
  // Plan tools — show the user a live checklist of the task. Intercepted in the
  // agent loop (lib/agent/run.ts), NOT in TOOL_FNS: they emit plan events, not
  // server work. See PLAN_TOOL_NAMES / dispatchPlanTool there.
  // ---------------------------------------------------------------------------
  {
    type: "function",
    function: {
      name: "write_plan",
      description:
        "Show the user a short checklist of the steps you'll take for a MULTI-STEP task (e.g. read their voice, search the swipe file, draft posts). Call this ONCE, first, only when the task genuinely has 2+ steps — skip it for a simple one-shot reply or a quick question. Then call update_plan as you finish each step. Keep it to 2-6 plain-language steps the user would recognize ('Read your voice profile', 'Search your swipe file', 'Draft 3 posts') — not tool names or internal mechanics.",
      parameters: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            items: { type: "string" },
            minItems: 2,
            maxItems: 6,
            description:
              "Ordered, short, user-facing step labels (2-6). Verb phrases like 'Draft 3 posts in your voice'. No tool names, no internal details.",
          },
        },
        required: ["steps"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_plan",
      description:
        "Advance the checklist you created with write_plan as you make progress: mark finished steps done and point to the one you're working on now. Call it right after you finish a step. Steps are 0-indexed in the order you listed them.",
      parameters: {
        type: "object",
        properties: {
          completed: {
            type: "array",
            items: { type: "integer", minimum: 0 },
            description:
              "Indices (0-based) of steps that are now FINISHED. Include all steps done so far, not just the newest.",
          },
          active: {
            type: "integer",
            minimum: 0,
            description:
              "Index (0-based) of the step you're working on now. Omit if all steps are done.",
          },
        },
      },
    },
  },
];

// Dispatch a single tool call. Unknown tool -> error result (never throws), so
// the agent loop can feed it back to the model.
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  workspaceId: string,
): Promise<ToolResult> {
  const fn = TOOL_FNS[name];
  if (!fn) return err(`Unknown tool: ${name}`);
  return fn(args, workspaceId);
}
