import type { SupabaseClient } from "@supabase/supabase-js";
import {
  discoveryThresholdFilter,
  getDiscoveryThresholds,
} from "@/lib/discovery-thresholds";
import { retryRead } from "@/lib/retry-read";

export const NO_SOURCE_POST_ROWS =
  "00000000-0000-0000-0000-000000000000";
export const MAX_SOURCE_POST_DISCOVERY_LIMIT = 200;
export const MAX_SOURCE_POST_PAGE_LIMIT = 100;
/**
 * The limit-branch over-fetches so workspace-declassified posts can't shrink a
 * result below the requested limit. Each attempt multiplies the read size;
 * both bounds keep a heavily-declassified workspace from scanning the table.
 */
export const DISCOVERY_OVERFETCH_MULTIPLIER = 4;
export const MAX_DISCOVERY_WIDENING_ATTEMPTS = 3;
export const MAX_SOURCE_POST_DISCOVERY_FETCH = 600;

export type SourcePostFilters = {
  niche?: string | null;
  query?: string | null;
  since?: string | null;
  from?: string | null;
  to?: string | null;
  minReactions?: number | null;
  minComments?: number | null;
  postType?: string | null;
};

export type SourcePostScope =
  | { accountIds: readonly string[]; categoryId?: never }
  | { categoryId: string; accountIds?: never };

export type SourcePostOrder = {
  column: string;
  ascending: boolean;
  secondaryPostedAtAscending?: boolean;
};

export type SourcePostWindow =
  | { kind: "limit"; limit: number }
  | { kind: "page"; offset: number; limit: number };

export type SourcePostDiscoveryRequest = SourcePostScope & {
  workspaceId: string;
  columns: string;
  filters?: SourcePostFilters;
  order: SourcePostOrder;
  window: SourcePostWindow;
  requirePositiveBaseline?: boolean;
  signal?: AbortSignal;
};

export type DiscoveredSourcePost = Record<string, unknown> & {
  id: string;
  accounts: unknown;
  text?: unknown;
  post_url?: unknown;
  posted_at?: unknown;
  workspace_post_classification?:
    | Array<{ is_viral: boolean }>
    | { is_viral: boolean }
    | null;
  is_viral?: unknown;
};

export type SourcePostDiscoveryResult = {
  rows: DiscoveredSourcePost[];
  nextOffset: number | null;
};

export class SourcePostDiscoveryError extends Error {
  readonly readError: unknown;

  constructor(readError: unknown) {
    const message =
      readError &&
      typeof readError === "object" &&
      "message" in readError &&
      typeof readError.message === "string"
        ? readError.message
        : "Failed to discover source posts";
    super(message);
    this.name = "SourcePostDiscoveryError";
    this.readError = readError;
  }
}

function isMissingSourcePostCountRpc(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "PGRST202",
  );
}

type WorkspaceClassificationEmbed = {
  workspace_post_classification?:
    | Array<{ is_viral: boolean }>
    | { is_viral: boolean }
    | null;
};

/**
 * Global virality is the availability fallback. A workspace-specific row only
 * overrides it when that workspace has explicitly classified the post.
 */
export function sourcePostPassesWorkspaceViral(
  row: WorkspaceClassificationEmbed,
): boolean {
  const embedded = row.workspace_post_classification;
  const classification = Array.isArray(embedded) ? embedded[0] : embedded;
  return classification ? classification.is_viral === true : true;
}

function boundedInteger(value: number, maximum: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

function discoveryColumns(columns: string): string {
  return columns.includes("workspace_post_classification(")
    ? columns
    : `${columns}, workspace_post_classification(is_viral)`;
}

/**
 * Canonical Source Post read used by the web Swipe File, Cowork, and MCP.
 * Adapters still own their presentation/ranking, while eligibility, workspace
 * scoping, and user-facing filters are defined once here.
 */
export async function discoverSourcePosts(
  db: SupabaseClient,
  request: SourcePostDiscoveryRequest,
): Promise<SourcePostDiscoveryResult> {
  const thresholds = await getDiscoveryThresholds(request.workspaceId, db);
  const filters = request.filters ?? {};
  const window: SourcePostWindow =
    request.window.kind === "page"
      ? {
          kind: "page",
          offset: Number.isFinite(request.window.offset)
            ? Math.max(0, Math.floor(request.window.offset))
            : 0,
          limit: boundedInteger(
            request.window.limit,
            MAX_SOURCE_POST_PAGE_LIMIT,
            30,
          ),
        }
      : {
          kind: "limit",
          limit: boundedInteger(
            request.window.limit,
            MAX_SOURCE_POST_DISCOVERY_LIMIT,
            10,
          ),
        };

  const buildQuery = (readWindow: SourcePostWindow) => {
    let query = db
      .from("posts")
      .select(discoveryColumns(request.columns))
      .eq("is_viral", true)
      .or(discoveryThresholdFilter(thresholds))
      .eq(
        "workspace_post_classification.workspace_id",
        request.workspaceId,
      )
      .is("accounts.archived_at", null)
      .order(request.order.column, {
        ascending: request.order.ascending,
        nullsFirst: false,
      });

    if ("accountIds" in request) {
      const accountIds = request.accountIds ?? [];
      query = query.in(
        "account_id",
        accountIds.length
          ? [...accountIds]
          : [NO_SOURCE_POST_ROWS],
      );
    } else {
      query = query
        .eq("accounts.category_id", request.categoryId)
        .eq(
          "accounts.workspace_accounts.workspace_id",
          request.workspaceId,
        );
    }

    if (
      request.order.secondaryPostedAtAscending !== undefined &&
      request.order.column !== "posted_at"
    ) {
      query = query.order("posted_at", {
        ascending: request.order.secondaryPostedAtAscending,
        nullsFirst: false,
      });
    }

    if (filters.niche) {
      query = query.ilike("accounts.niche", filters.niche);
    }
    if (filters.query?.trim()) {
      query = query.textSearch("text", filters.query.trim(), {
        type: "websearch",
        config: "english",
      });
    }
    if (filters.since) query = query.gte("posted_at", filters.since);
    if (filters.from) query = query.gte("posted_at", filters.from);
    if (filters.to) query = query.lte("posted_at", filters.to);
    if (filters.minReactions != null) {
      query = query.gte("reactions", filters.minReactions);
    }
    if (filters.minComments != null) {
      query = query.gte("comments", filters.minComments);
    }
    if (filters.postType) query = query.eq("post_type", filters.postType);
    if (request.requirePositiveBaseline) {
      query = query
        .not("baseline_score", "is", null)
        .gt("baseline_score", 0);
    }
    if (request.signal) query = query.abortSignal(request.signal);

    return readWindow.kind === "page"
      ? query.range(
          readWindow.offset,
          readWindow.offset + readWindow.limit,
        )
      : query.limit(readWindow.limit);
  };

  if (window.kind === "limit") {
    // Eligibility is enforced in two places: SQL-side (is_viral, thresholds,
    // window) and JS-side (sourcePostPassesWorkspaceViral, which drops posts
    // THIS workspace explicitly declassified). Asking the DB for exactly
    // `limit` rows and then applying the JS filter under-fills the result by
    // however many declassified rows happened to rank highest — a request for
    // 5 could come back with 1, which is what made MCP research answers look
    // like "only one post exists this week".
    //
    // Over-fetch and keep widening until we have `limit` eligible rows or the
    // table runs out. Bounded so a workspace that declassified nearly
    // everything can't turn one read into an unbounded scan.
    const rows: DiscoveredSourcePost[] = [];
    let fetchSize = window.limit;
    for (let attempt = 0; attempt < MAX_DISCOVERY_WIDENING_ATTEMPTS; attempt += 1) {
      fetchSize = Math.min(
        fetchSize * DISCOVERY_OVERFETCH_MULTIPLIER,
        MAX_SOURCE_POST_DISCOVERY_FETCH,
      );
      const { data, error } = await retryRead<DiscoveredSourcePost[]>(
        () => buildQuery({ kind: "limit", limit: fetchSize }) as unknown as PromiseLike<{
          data: DiscoveredSourcePost[] | null;
          error: { message?: string; code?: string } | null;
        }>,
        { signal: request.signal },
      );
      if (error) throw new SourcePostDiscoveryError(error);
      const rawRows = data ?? [];
      rows.length = 0;
      for (const row of rawRows) {
        if (!sourcePostPassesWorkspaceViral(row)) continue;
        rows.push(row);
        if (rows.length === window.limit) break;
      }
      // Enough eligible rows, or the table is exhausted (the DB returned fewer
      // than we asked for, so widening again can't surface anything new).
      if (rows.length === window.limit || rawRows.length < fetchSize) break;
      if (fetchSize >= MAX_SOURCE_POST_DISCOVERY_FETCH) break;
    }
    return { rows, nextOffset: null };
  }

  const rows: DiscoveredSourcePost[] = [];
  const chunkSize = window.limit + 1;
  let rawOffset = window.offset;

  for (;;) {
    const readWindow: SourcePostWindow = {
      kind: "page",
      offset: rawOffset,
      // range() is inclusive, so this requests exactly chunkSize rows.
      limit: chunkSize - 1,
    };
    const { data, error } = await retryRead<DiscoveredSourcePost[]>(
      () => buildQuery(readWindow) as unknown as PromiseLike<{
        data: DiscoveredSourcePost[] | null;
        error: { message?: string; code?: string } | null;
      }>,
      { signal: request.signal },
    );
    if (error) throw new SourcePostDiscoveryError(error);
    const rawRows = data ?? [];

    for (let index = 0; index < rawRows.length; index += 1) {
      const row = rawRows[index];
      if (!sourcePostPassesWorkspaceViral(row)) continue;
      if (rows.length === window.limit) {
        return { rows, nextOffset: rawOffset + index };
      }
      rows.push(row);
    }

    if (rawRows.length < chunkSize) {
      return { rows, nextOffset: null };
    }
    rawOffset += rawRows.length;
  }
}

export async function countSourcePosts(
  db: SupabaseClient,
  request: SourcePostScope & {
    workspaceId: string;
    filters?: SourcePostFilters;
    requirePositiveBaseline?: boolean;
    signal?: AbortSignal;
  },
): Promise<number> {
  const thresholds = await getDiscoveryThresholds(request.workspaceId, db);
  const filters = request.filters ?? {};

  if (typeof db.rpc === "function") {
    const { data, error } = await retryRead<unknown>(
      () =>
        db.rpc("count_source_posts", {
          p_workspace_id: request.workspaceId,
          p_account_ids:
            "accountIds" in request
              ? [...(request.accountIds ?? [])]
              : null,
          p_category_id:
            "categoryId" in request ? request.categoryId : null,
          p_niche: filters.niche ?? null,
          p_query: filters.query?.trim() || null,
          p_since: filters.since ?? null,
          p_from: filters.from ?? null,
          p_to: filters.to ?? null,
          p_min_reactions: filters.minReactions ?? null,
          p_min_comments: filters.minComments ?? null,
          p_post_type: filters.postType ?? null,
          p_require_positive_baseline:
            request.requirePositiveBaseline === true,
          p_regular_enabled: thresholds.regular.enabled,
          p_regular_min_likes: thresholds.regular.minLikes,
          p_lead_magnet_enabled: thresholds.leadMagnet.enabled,
          p_lead_magnet_min_comments:
            thresholds.leadMagnet.minComments,
        }),
      { signal: request.signal },
    );
    if (!error) {
      const count = typeof data === "string" ? Number(data) : data;
      if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
        throw new SourcePostDiscoveryError({
          message: "Source Post count returned an invalid result",
        });
      }
      return Math.trunc(count);
    }
    if (!isMissingSourcePostCountRpc(error)) {
      throw new SourcePostDiscoveryError(error);
    }
  }

  // Lightweight query doubles and deployments whose additive count RPC has not
  // reached the PostgREST schema cache use the same canonical eligibility scan.
  // The RPC remains the normal constant-size path once migration 154 is live.
  const pageSize = MAX_SOURCE_POST_PAGE_LIMIT;
  let offset = 0;
  let count = 0;
  const countColumns =
    "accountIds" in request
      ? "id, accounts!inner(id)"
      : "id, accounts!inner(id, workspace_accounts!inner())";

  for (;;) {
    const page = await discoverSourcePosts(db, {
      ...request,
      columns: countColumns,
      order: { column: "id", ascending: true },
      window: { kind: "page", offset, limit: pageSize },
    });
    count += page.rows.length;
    if (page.nextOffset === null) return count;
    offset = page.nextOffset;
  }
}
