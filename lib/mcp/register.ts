import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ImageContent,
  ServerRequest,
  ServerNotification,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import {
  TrackedCreatorError,
  TrackedCreators,
} from "@/lib/tracked-creators";
import { createSupabaseTrackedCreatorsRepository } from "@/lib/tracked-creators-supabase";
import {
  latestRelevantScrapeForService,
  trackedAccountIdsForService,
} from "@/lib/supabase-scoped";
import { validateCategoryId } from "@/lib/categories";
import { canPublish, getConnection } from "@/lib/publishing";
import {
  DraftLifecycle,
  type DraftRecord,
} from "@/lib/draft-lifecycle";
import { createSupabaseDraftLifecycleRepository } from "@/lib/draft-lifecycle-supabase";
import {
  dbErrorContent,
  errorContent,
  jsonContent,
  notFoundContent,
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
import {
  calendarDateSchema,
  timeZoneSchema,
} from "@/lib/schedule-local-date";
import { sanitizeVoiceProfile } from "@/lib/claude";
import { registerPublicResourceTools } from "./register-resources";
import {
  findBookmarkResource,
  listBookmarkResources,
  saveBookmarkResource,
  summarizeBookmarkResource,
} from "@/lib/content-resource-operations";

const POST_TYPES = ["regular", "lead_magnet"] as const;
const SORT_COLUMN = {
  viral: "viral_score",
  reactions: "reactions",
  comments: "comments",
  posted: "posted_at",
} as const;

// No templates(template_text) join — like the in-app agent's POST_COLS
// (lib/agent/tools.ts), the LLM never reads the templatized skeleton and it's
// ~10K tokens per result re-sent every tool round. Kept in sync with that file.
// Only fields an LLM reasons over — kept in sync with the in-app agent's
// POST_COLS (lib/agent/tools.ts). Trimmed the fields the model never consumes
// and that downstream code re-fetches on its own (account_id,
// accounts.id/handle/profile_pic_url, scraped_at [top-level scrape date is
// surfaced separately], is_viral [constant — every query filters
// is_viral=true]). Keeps text + engagement + author name/niche + post_url/id.
// workspace_post_classification!inner(is_viral) is embedded (not filtered on
// the GLOBAL posts.is_viral column two workspaces tracking the same creator
// would otherwise share — backlog #153 / migration-075) and filtered per-query
// via .eq("workspace_post_classification.workspace_id", workspaceId)
// .eq("workspace_post_classification.is_viral", true).
const POST_COLS =
  "id, text, post_url, posted_at, reactions, comments, reposts, media_type, post_type, accounts!inner(name, niche), workspace_post_classification!inner(is_viral)";

// Visual URLs can be large and are rarely needed to answer a broad research
// query. Fetch them only when the caller is looking at one post, or has
// explicitly asked to see the post's visual asset.
const POST_WITH_VISUAL_COLS =
  "id, text, post_url, posted_at, reactions, comments, reposts, media_type, post_type, media_urls, visual_kind, accounts!inner(name, niche), workspace_post_classification!inner(is_viral)";

const NO_ROWS_SENTINEL = "00000000-0000-0000-0000-000000000000";

// "Top from the latest scrape" = best posts PUBLISHED in this many days before
// the most recent scrape run. 7 days ("this week" / what's working now), kept in
// sync with lib/agent/tools.ts's TOP_BATCH_DEFAULT_WINDOW_DAYS. (The in-app chat
// tool also accepts a window_days override; this external MCP surface keeps the
// fixed 7-day window for simplicity.)
const TOP_BATCH_WINDOW_DAYS = 7;
// Two 1 MiB images stay below common serverless response-body limits even
// after base64 expansion, while the JSON result still exposes every source URL.
const MAX_RENDERED_POST_IMAGES = 2;
const MAX_RENDERED_IMAGE_BYTES = 1 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 6_000;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

// Drops the workspace_post_classification join wrapper (a query filter, not a
// field the model needs) and unwraps the accounts embed.
function normalizeEmbed<
  T extends { accounts: unknown; workspace_post_classification?: unknown },
>(p: T, includeVisual = false) {
  const {
    workspace_post_classification: _wpc,
    media_urls,
    visual_kind,
    ...rest
  } = p as T & { media_urls?: unknown; visual_kind?: unknown };
  void _wpc;
  const post = {
    ...rest,
    accounts: Array.isArray(p.accounts) ? (p.accounts[0] ?? null) : p.accounts,
  };
  if (!includeVisual) return post;

  return {
    ...post,
    media_urls: Array.isArray(media_urls)
      ? media_urls.filter((url): url is string => typeof url === "string")
      : [],
    visual_kind: typeof visual_kind === "string" ? visual_kind : null,
  };
}

function postColumns(includeVisual: boolean): typeof POST_COLS {
  // supabase-js's select-string parser only accepts the baseline literal type.
  // The visual projection is a strict superset of that shape, and
  // normalizeEmbed narrows those optional fields before exposing them.
  return (includeVisual ? POST_WITH_VISUAL_COLS : POST_COLS) as typeof POST_COLS;
}

function shouldIncludePostVisual(
  limit: number,
  includeVisual: boolean | undefined,
) {
  return limit === 1 || includeVisual === true;
}

function linkedInMediaUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4_096) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "media.licdn.com"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function visualUrlsFromPosts(posts: unknown[]) {
  const urls = new Set<string>();
  for (const post of posts) {
    if (!post || typeof post !== "object") continue;
    const mediaUrls = (post as { media_urls?: unknown }).media_urls;
    if (!Array.isArray(mediaUrls)) continue;
    for (const mediaUrl of mediaUrls) {
      const url = linkedInMediaUrl(mediaUrl);
      if (url) urls.add(url);
      if (urls.size === MAX_RENDERED_POST_IMAGES) return [...urls];
    }
  }
  return [...urls];
}

async function readImageBytes(response: Response): Promise<Uint8Array | null> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RENDERED_IMAGE_BYTES) {
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RENDERED_IMAGE_BYTES) {
      void reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function renderPostImage(url: string): Promise<ImageContent | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { Accept: "image/*" },
      redirect: "error",
      signal: controller.signal,
    });
    const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase();
    if (!response.ok || !mimeType || !SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
      return null;
    }
    const bytes = await readImageBytes(response);
    if (!bytes) return null;
    return {
      type: "image",
      data: Buffer.from(bytes).toString("base64"),
      mimeType,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function postContentWithRenderedImages(payload: unknown, posts: unknown[]) {
  const urls = visualUrlsFromPosts(posts);
  if (urls.length === 0) return jsonContent(payload);
  const images = (await Promise.all(urls.map(renderPostImage))).filter(
    (image): image is ImageContent => image !== null,
  );
  return {
    content: [...jsonContent(payload).content, ...images],
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

const DRAFT_STATUSES = ["idea", "drafting", "ready", "posted"] as const;

function trackedCreatorsForWorkspace(workspaceId: string) {
  const db = supabaseAdmin();
  return new TrackedCreators(
    createSupabaseTrackedCreatorsRepository(db, workspaceId),
  );
}

function draftLifecycleForWorkspace(workspaceId: string) {
  const db = supabaseAdmin();
  return new DraftLifecycle(
    createSupabaseDraftLifecycleRepository(db, workspaceId),
    {
      canPublish: async () => canPublish(await getConnection(workspaceId)),
    },
  );
}

function draftForMcp(draft: DraftRecord) {
  return {
    id: draft.id,
    title: draft.title,
    kind: draft.kind,
    status: draft.status,
    plan_to_post_on: draft.planToPostOn,
    scheduled_at: draft.scheduledAt,
    schedule_status: draft.scheduleStatus,
    first_comment: draft.firstComment,
    published_at: draft.publishedAt,
    publish_error: draft.publishError,
    created_at: draft.createdAt,
  };
}

function trackedCreatorFailure(error: unknown) {
  // A TrackedCreatorError's message is an app-level, caller-facing message
  // (e.g. "niche is required") — safe to forward. Anything else is an
  // unexpected error (DB failure, bad filter value tripping a PostgREST
  // parse error, etc.) whose raw .message can leak schema/column/constraint
  // internals, so it goes through the same sanitized path as every other
  // query failure instead of being forwarded verbatim.
  if (error instanceof TrackedCreatorError) return errorContent(error.message);
  return dbErrorContent("tracked_creators", error);
}

export function registerSwipeTools(server: McpServer) {
  // -------------------------------------------------------------------------
  // Read-only: swipe file (scoped to the workspace's tracked accounts)
  // -------------------------------------------------------------------------

  server.registerTool(
    "search_viral_posts",
    {
      title: "Search viral posts",
      description:
        "Search the viral swipe file. Filter by niche, date range, engagement thresholds, and post type. Returns top matching posts from accounts your workspace tracks. A one-post search includes rendered original images when available; set include_visual to true for images in a larger result set.",
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
        include_visual: z
          .boolean()
          .optional()
          .describe("Include rendered original images, visual asset URLs, and visual metadata. Use when the user asks to see a post's image or visual asset. Always included when limit is 1."),
      },
    },
    async (args, extra) => {
      try {
        const workspaceId = workspaceFromExtra(extra);
        if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
        const accountIds = await trackedAccountIdsForService(workspaceId);
        const sb = supabaseAdmin();
        const sortKey = args.sort ?? "viral";
        const sortCol = SORT_COLUMN[sortKey];
        const ascending = args.dir === "asc";
        const limit = args.limit ?? 10;
        const includeVisual = shouldIncludePostVisual(limit, args.include_visual);

        let q = sb
          .from("posts")
          .select(postColumns(includeVisual))
          .in("account_id", accountIds.length ? accountIds : [NO_ROWS_SENTINEL])
          .eq("workspace_post_classification.workspace_id", workspaceId)
          .eq("workspace_post_classification.is_viral", true)
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
        if (error) return dbErrorContent("search_viral_posts", error);
        const posts = (data ?? []).map((post) => normalizeEmbed(post, includeVisual));
        return includeVisual
          ? await postContentWithRenderedImages({ ok: true, count: posts.length, posts }, posts)
          : jsonContent({ ok: true, count: posts.length, posts });
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
        "Fetch a single post by id, including rendered original images, visual URLs, and visual metadata when available. Only returns posts from accounts your workspace tracks.",
      inputSchema: { id: z.string().uuid().describe("Post UUID.") },
    },
    async ({ id }, extra) => {
      try {
        const workspaceId = workspaceFromExtra(extra);
        if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
        const accountIds = await trackedAccountIdsForService(workspaceId);
        if (accountIds.length === 0) return notFoundContent("Post", id);

        const sb = supabaseAdmin();
        const { data, error } = await sb
          .from("posts")
          .select(postColumns(true))
          .eq("id", id)
          .in("account_id", accountIds)
          .maybeSingle();
        if (error) return notFoundContent("Post", id);
        if (!data) return notFoundContent("Post", id);
        const post = normalizeEmbed(data, true);
        return postContentWithRenderedImages({ ok: true, post }, [post]);
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
        const accountIds = await trackedAccountIdsForService(workspaceId);
        if (accountIds.length === 0) return jsonContent({ ok: true, niches: [] });

        const sb = supabaseAdmin();
        // Prefer the per-workspace niche override; fall back to the global account niche.
        const { data, error } = await sb
          .from("workspace_accounts")
          .select("niche, accounts!inner(niche, archived_at)")
          .eq("workspace_id", workspaceId)
          .is("accounts.archived_at", null);
        if (error) return dbErrorContent("list_niches", error);

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
      title: "Get top recently-published posts as of the most recent scrape",
      description:
        "Returns the highest-engagement RECENTLY-PUBLISHED posts (last 7 days before the most recent scrape — 'this week' / what's working now) from your workspace's tracked accounts. Filtered by publish date, not scrape date — a scrape re-ingests old posts too, so ranking by scrape date would surface stale posts. The result's `scrape.scraped_at` is the real scrape date and `scrape.window_days` the window used; each post carries its own `posted_at`. Pass `post_type` to restrict to 'regular' or 'lead_magnet' posts; omit to include both. A one-post request includes rendered original images when available; set include_visual to true for images in a larger result set.",
      inputSchema: {
        limit: z.number().int().min(1).max(20).optional().describe("Default 5, max 20."),
        post_type: z
          .enum(POST_TYPES)
          .optional()
          .describe("Restrict to 'regular' or 'lead_magnet' posts. Omit to include both."),
        include_visual: z
          .boolean()
          .optional()
          .describe("Include rendered original images, visual asset URLs, and visual metadata. Use when the user asks to see a post's image or visual asset. Always included when limit is 1."),
      },
    },
    async ({ limit, post_type, include_visual }, extra) => {
      try {
        const workspaceId = workspaceFromExtra(extra);
        if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
        const accountIds = await trackedAccountIdsForService(workspaceId);
        if (accountIds.length === 0) {
          return jsonContent({ ok: true, posts: [], note: "Workspace tracks no accounts." });
        }

        const sb = supabaseAdmin();
        const lastRun = await latestRelevantScrapeForService(workspaceId);
        if (!lastRun?.started_at) {
          return jsonContent({ ok: true, posts: [], note: "No successful scrape run found yet." });
        }
        // Filter by PUBLISH date, not scrape date: a scrape re-ingests each
        // creator's recent history, so scraped_at is the run date even for old
        // posts. Window = the N days before the scrape, so "top from the latest
        // scrape" means the best RECENTLY-PUBLISHED posts (see tools.ts).
        const runStartMs = new Date(lastRun.started_at as string).getTime();
        const sinceIso = new Date(
          runStartMs - TOP_BATCH_WINDOW_DAYS * 24 * 60 * 60 * 1000,
        ).toISOString();
        const resultLimit = limit ?? 5;
        const includeVisual = shouldIncludePostVisual(resultLimit, include_visual);
        let q = sb
          .from("posts")
          .select(postColumns(includeVisual))
          .in("account_id", accountIds)
          .eq("workspace_post_classification.workspace_id", workspaceId)
          .eq("workspace_post_classification.is_viral", true)
          .is("accounts.archived_at", null)
          .gte("posted_at", sinceIso)
          .order("reactions", { ascending: false, nullsFirst: false })
          .limit(resultLimit);
        // Optional post-type filter (regular vs lead_magnet) so "top regular
        // posts" doesn't silently include lead-magnet posts.
        if (post_type) q = q.eq("post_type", post_type);
        const { data, error } = await q;
        if (error) return dbErrorContent("get_top_from_batch", error);
        const posts = (data ?? []).map((post) => normalizeEmbed(post, includeVisual));
        const payload = {
          ok: true,
          scrape: {
            scraped_at: lastRun.finished_at ?? lastRun.started_at,
            posts_published_since: sinceIso,
            window_days: TOP_BATCH_WINDOW_DAYS,
          },
          count: data?.length ?? 0,
          posts,
        };
        return includeVisual
          ? await postContentWithRenderedImages(payload, posts)
          : jsonContent(payload);
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
        const creators = trackedCreatorsForWorkspace(workspaceId);
        const filters = {
          niche: args.niche,
          search: args.search,
          includeArchived: args.include_archived,
        };
        const [rows, total] = await Promise.all([
          creators.list({ ...filters, limit: args.limit }),
          creators.listTotal(filters),
        ]);
        const accounts = rows.map((account) => ({
          id: account.id,
          name: account.name,
          linkedin_handle: account.linkedinHandle,
          profile_url: account.profileUrl,
          niche: account.niche,
          source: account.source,
          synced_at: account.syncedAt,
          archived_at: account.archivedAt,
          workspace_niche: account.workspaceNiche,
          effective_niche: account.effectiveNiche,
          tracked_at: account.trackedAt,
        }));
        // count = rows returned this page; total = rows matching the same
        // filters overall — so a caller can tell "50 of 132" apart from
        // "that's everything" instead of count implying completeness.
        return jsonContent({ ok: true, count: accounts.length, total, accounts });
      } catch (e) {
        return trackedCreatorFailure(e);
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
        const result = await trackedCreatorsForWorkspace(workspaceId).add({
          profileUrl: profile_url,
          name,
          workspaceNiche: niche ?? null,
          duplicate: "return_existing",
          resolveProfileMeta: false,
        });
        const account = result.account;

        return jsonContent({
          ok: true,
          account: {
            id: account.id,
            name: account.name,
            linkedin_handle: account.linkedinHandle,
            profile_url: account.profileUrl,
            niche: account.niche,
            source: account.source,
            synced_at: account.syncedAt,
            archived_at: account.archivedAt,
            workspace_niche: niche?.trim() || null,
            effective_niche: niche?.trim() || account.niche,
          },
          created_new_catalog_row: result.created,
        });
      } catch (e) {
        return trackedCreatorFailure(e);
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
        const result = await trackedCreatorsForWorkspace(
          workspaceId,
        ).updateWorkspaceNiche({
          id: args.id,
          handle: args.linkedin_handle,
          profileUrl: args.profile_url,
          niche: args.niche,
        });
        const account = result.account;
        return jsonContent({
          ok: true,
          account: {
            id: account.id,
            name: account.name,
            linkedin_handle: account.linkedinHandle,
            profile_url: account.profileUrl,
            niche: account.niche,
            source: account.source,
            synced_at: account.syncedAt,
            archived_at: account.archivedAt,
            workspace_niche: result.workspaceNiche,
            effective_niche: result.effectiveNiche,
          },
        });
      } catch (e) {
        return trackedCreatorFailure(e);
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
        const account = await trackedCreatorsForWorkspace(workspaceId).remove({
          id: args.id,
          handle: args.linkedin_handle,
          profileUrl: args.profile_url,
        });
        return jsonContent({ ok: true, untracked_account_id: account.id });
      } catch (e) {
        return trackedCreatorFailure(e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Read/write: saved drafts and LinkedIn publishing schedule
  // -------------------------------------------------------------------------

  server.registerTool(
    "list_drafts",
    {
      title: "List saved drafts",
      description:
        "List this workspace's saved post drafts from the Posts board. Use this before scheduling so you target an actual draft id. Returns schedule fields but not the full post body.",
      inputSchema: {
        status: z
          .enum(DRAFT_STATUSES)
          .optional()
          .describe("Filter by board status. Omit to include all board drafts."),
        limit: z.number().int().min(1).max(100).optional().describe("Default 50, max 100."),
      },
    },
    async ({ status, limit }, extra) => {
      try {
        const workspaceId = workspaceFromExtra(extra);
        if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
        const drafts = await draftLifecycleForWorkspace(workspaceId).list({
          status,
          limit: limit ?? 50,
        });
        return jsonContent({
          ok: true,
          count: drafts.length,
          drafts: drafts.map(draftForMcp),
        });
      } catch (e) {
        return errorContent((e as Error).message);
      }
    },
  );

  server.registerTool(
    "schedule_draft",
    {
      title: "Schedule a saved draft on LinkedIn",
      description:
        "Create or update the real LinkedIn auto-publish schedule for one saved draft. The workspace must have LinkedIn connected. Use list_drafts first to get the draft id. scheduled_at must be an ISO datetime in the future.",
      inputSchema: {
        id: z.string().uuid().describe("Draft UUID from list_drafts."),
        scheduled_at: z
          .string()
          .datetime()
          .describe("Future ISO datetime when the post should publish."),
        plan_to_post_on: calendarDateSchema
          .optional()
          .describe("The user's local calendar date (YYYY-MM-DD) for the Posts calendar."),
        timezone: timeZoneSchema
          .optional()
          .describe(
            "The user's IANA timezone (e.g. 'America/New_York'). When plan_to_post_on is omitted, the calendar date is derived from scheduled_at in this timezone (UTC if also omitted). Pass it whenever you know the user's timezone.",
          ),
        first_comment: z
          .string()
          .trim()
          .max(3000)
          .nullable()
          .optional()
          .describe("Optional first comment to publish with the post."),
      },
    },
    async ({ id, scheduled_at, plan_to_post_on, timezone, first_comment }, extra) => {
      try {
        const workspaceId = workspaceFromExtra(extra);
        if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);

        const outcome = await draftLifecycleForWorkspace(workspaceId).schedule(id, {
          scheduledAt: scheduled_at,
          planToPostOn: plan_to_post_on,
          timezone,
          firstComment: first_comment,
        });
        if (!outcome.ok) return errorContent(outcome.message);
        return jsonContent({ ok: true, draft: draftForMcp(outcome.value) });
      } catch (e) {
        return errorContent((e as Error).message);
      }
    },
  );

  server.registerTool(
    "unschedule_draft",
    {
      title: "Cancel a draft's LinkedIn schedule",
      description:
        "Cancel a saved draft's LinkedIn auto-publish schedule while it is still scheduled. Published or currently publishing drafts cannot be cancelled.",
      inputSchema: {
        id: z.string().uuid().describe("Draft UUID from list_drafts."),
      },
    },
    async ({ id }, extra) => {
      try {
        const workspaceId = workspaceFromExtra(extra);
        if (!workspaceId) return errorContent(NO_WORKSPACE_MSG);
        const outcome = await draftLifecycleForWorkspace(
          workspaceId,
        ).cancelSchedule(id);
        if (!outcome.ok) return errorContent(outcome.message);
        return jsonContent({ ok: true, draft: draftForMcp(outcome.value) });
      } catch (e) {
        return errorContent((e as Error).message);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Read-only: voice profile (one per workspace — the user's own writing voice,
  // synthesized from their last ~50 LinkedIn posts in the Voice tab).
  // Draft-generation prompts read this so AI-written content actually sounds
  // like the user.
  // -------------------------------------------------------------------------

  server.registerTool(
    "get_voice",
    {
      title: "Get this workspace's voice profile",
      description:
        "Fetch the workspace owner's writing-voice profile, synthesized from their recent LinkedIn posts. Returns a structured profile: a plain-English summary, target audience, topics, positioning, tone, and detailed format patterns (hooks, structure, length, sentence rhythm, paragraphing, vocabulary, punctuation, and rhetorical devices), plus signature moves, do/don't lists, and verbatim exemplars. Treat those writing mechanics as first-class drafting instructions. The core voice describes REGULAR posts. An optional profile.lead_magnet_style block applies only to promotional giveaway posts. Read this before drafting any post in the user's voice. Returns ok:false when no voice has been generated yet.",
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
        if (error) return dbErrorContent("get_voice", error);
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
            profile: sanitizeVoiceProfile(data.profile),
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
        const account = await trackedCreatorsForWorkspace(workspaceId).restore({
          id: args.id,
          handle: args.linkedin_handle,
          profileUrl: args.profile_url,
        });

        return jsonContent({
          ok: true,
          account: {
            id: account.id,
            name: account.name,
            linkedin_handle: account.linkedinHandle,
            profile_url: account.profileUrl,
            niche: account.niche,
            source: account.source,
            synced_at: account.syncedAt,
            archived_at: account.archivedAt,
            workspace_niche: null,
            effective_niche: account.niche,
          },
        });
      } catch (e) {
        return trackedCreatorFailure(e);
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
            "Optional niche tag — one of the curated category ids (e.g. 'linkedin-content', 'ai', 'outreach'; call list_categories for the full, current list). An unrecognized id is dropped rather than failing the save — the response's category_warning field says so when that happens.",
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

        const existing = await findBookmarkResource({
          db: sb,
          workspaceId,
          activityId,
        });
        if (existing) {
          return jsonContent({
            ok: true,
            alreadySaved: true,
            saved: summarizeBookmarkResource(existing),
          });
        }

        // Validate the optional category against the categories this workspace
        // may use (curated globals + its own custom ones). FK violation here
        // would crash the save with a 23503 instead of a helpful "invalid
        // category" message, so we drop unknown/foreign values rather than
        // failing the save — but never SILENTLY: category_warning tells the
        // caller their tag didn't stick, instead of them assuming it did.
        let categoryId: string | null = null;
        let categoryWarning: string | null = null;
        const rawCategory = args.category?.trim();
        if (rawCategory) {
          const catResult = await validateCategoryId(sb, rawCategory, workspaceId);
          if (catResult.ok) {
            categoryId = catResult.categoryId;
          } else {
            categoryWarning = `"${rawCategory}" isn't a category this workspace can use — saved without a category. Call list_categories for valid ids.`;
          }
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

        const result = await saveBookmarkResource({
          db: sb,
          workspaceId,
          activityId,
          knownAbsent: true,
          values: {
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
          },
        });

        return jsonContent({
          ok: true,
          alreadySaved: result.existed,
          saved: summarizeBookmarkResource(result.saved),
          ...(categoryWarning ? { category_warning: categoryWarning } : {}),
        });
      } catch (e) {
        return dbErrorContent("save_post", e);
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
        const saved = await listBookmarkResources({
          db: sb,
          workspaceId,
          limit,
        });
        return jsonContent({
          ok: true,
          count: saved.length,
          saved: saved.map(summarizeBookmarkResource),
        });
      } catch (e) {
        return dbErrorContent("list_saved_posts", e);
      }
    },
  );

  registerPublicResourceTools(server, workspaceFromExtra);
}
