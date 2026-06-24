import { supabaseAdmin } from "@/lib/supabase";
import { trackedAccountIds } from "@/lib/supabase-scoped";
import { neutralizeMarkers } from "@/lib/agent/untrusted";

// ---------------------------------------------------------------------------
// Cited source posts — resolve a post id the chat agent referenced (via a
// ```cite block) into the card data the chat renders inline.
//
// Security: the id comes from the model's output (it saw the id in a tool
// result). We resolve it SERVER-SIDE, scoped to the workspace's tracked
// accounts — so a hallucinated or cross-workspace id simply returns nothing.
// Two gates: callers validate the id is a UUID before calling here, and the
// query filters on account_id ∈ trackedAccountIds. No post text or media ever
// crosses the model boundary — only the id does; the card is built here.
// ---------------------------------------------------------------------------

// The read-only card fields the inline citation needs. Mirrors the subset of
// PostRow the InlineSourceCard renders. Engagement counts + media URLs are
// resolved fresh each time (LinkedIn media URLs expire ~weekly, so we never
// snapshot them — see the chat persistence note).
export type CitedPost = {
  id: string;
  text: string | null;
  postUrl: string | null;
  postedAt: string | null;
  reactions: number;
  comments: number;
  reposts: number;
  mediaType: string;
  mediaUrls: string[];
  visualKind: "photo" | "graphic" | null;
  authorName: string;
  authorNiche: string | null;
  authorAvatar: string | null;
};

const CITE_COLS =
  "id, text, post_url, posted_at, reactions, comments, reposts, media_type, media_urls, visual_kind, account_id, accounts!inner(name, niche, profile_pic_url)";

// Matches no rows — so `.in("account_id", [])` (a workspace with no tracked
// accounts) never degenerates into "no filter" and leaks other workspaces.
const NO_ROWS_SENTINEL = "00000000-0000-0000-0000-000000000000";

// How many cited cards we'll resolve+render per assistant turn. Bounds DOM,
// image-optimizer load, and DB work even if the model over-cites.
export const MAX_CITES = 4;

type Row = {
  id: string;
  text: string | null;
  post_url: string | null;
  posted_at: string | null;
  reactions: number | null;
  comments: number | null;
  reposts: number | null;
  media_type: string | null;
  media_urls: string[] | null;
  visual_kind: "photo" | "graphic" | null;
  accounts:
    | { name?: string; niche?: string | null; profile_pic_url?: string | null }
    | { name?: string; niche?: string | null; profile_pic_url?: string | null }[]
    | null;
};

function toCard(row: Row): CitedPost {
  const acc = Array.isArray(row.accounts) ? row.accounts[0] : row.accounts;
  return {
    id: row.id,
    // Neutralize forged envelope markers in the scraped post body before it
    // leaves the server, so a malicious post can't poison a later turn if the
    // card text is ever re-fed to the model.
    text: row.text ? neutralizeMarkers(row.text) : null,
    postUrl: row.post_url,
    postedAt: row.posted_at,
    reactions: row.reactions ?? 0,
    comments: row.comments ?? 0,
    reposts: row.reposts ?? 0,
    mediaType: row.media_type ?? "none",
    mediaUrls: row.media_urls ?? [],
    visualKind: row.visual_kind ?? null,
    authorName: acc?.name ?? "Unknown",
    authorNiche: acc?.niche ?? null,
    authorAvatar: acc?.profile_pic_url ?? null,
  };
}

// A persisted artifact as it comes back from chat_messages.artifacts (loosely
// typed — we only touch kind + meta.postId here).
type StoredArtifact = {
  kind?: string;
  meta?: { postId?: string; card?: CitedPost } | null;
  [k: string]: unknown;
};
// Loaded message rows carry `artifacts` as untyped JSON (`unknown`), so the
// constraint stays loose and we narrow at runtime.
type MessageWithArtifacts = { artifacts?: unknown };

function asArtifacts(v: unknown): StoredArtifact[] {
  return Array.isArray(v) ? (v as StoredArtifact[]) : [];
}

// Re-attach resolved card data to the "cite" artifacts across a loaded chat
// transcript. We persist only meta.postId (cards go stale), so on load we batch-
// resolve every cited id once (workspace-scoped) and fill meta.card back in.
// Mutates nothing — returns new message objects. Never throws; on any failure
// the cite artifacts just keep their (missing) card and the client drops them.
export async function rehydrateCites<T extends MessageWithArtifacts>(
  messages: T[],
  workspaceId: string,
): Promise<T[]> {
  try {
    const ids = new Set<string>();
    for (const m of messages) {
      for (const a of asArtifacts(m.artifacts)) {
        if (a.kind === "cite" && a.meta?.postId) ids.add(a.meta.postId);
      }
    }
    if (ids.size === 0) return messages;
    // Resolve every cited id across the whole transcript in one query (no
    // per-turn cap here — each message was already capped at MAX_CITES when
    // persisted, and we want all of them back).
    const byId = await queryCards([...ids], workspaceId);
    return messages.map((m) => {
      const arts = asArtifacts(m.artifacts);
      if (!arts.some((a) => a.kind === "cite")) return m;
      return {
        ...m,
        artifacts: arts.map((a) =>
          a.kind === "cite" && a.meta?.postId
            ? { ...a, meta: { ...a.meta, card: byId.get(a.meta.postId) } }
            : a,
        ),
      };
    });
  } catch {
    return messages;
  }
}

// Resolve up to MAX_CITES post ids to cards, scoped to the workspace's tracked
// accounts, preserving the order ids were cited in. Never throws — any failure
// (DB error, no tracked accounts) returns []. Unresolvable ids (deleted /
// out-of-workspace) are simply absent from the result, so the caller drops
// those cards and keeps the text. Duplicate ids are de-duped.
export async function resolveCitedPosts(
  ids: string[],
  workspaceId: string,
): Promise<CitedPost[]> {
  const unique = [...new Set(ids)].slice(0, MAX_CITES);
  if (unique.length === 0) return [];
  const byId = await queryCards(unique, workspaceId);
  // Preserve citation order; drop ids that didn't resolve.
  return unique.map((id) => byId.get(id)).filter((c): c is CitedPost => !!c);
}

// Workspace-scoped batch lookup: ids → Map<id, CitedPost>. The scope gate
// (.in account_id ∈ trackedAccountIds, with the no-rows sentinel) means a
// hallucinated or cross-workspace id simply isn't in the result. Never throws.
async function queryCards(
  ids: string[],
  workspaceId: string,
): Promise<Map<string, CitedPost>> {
  try {
    if (ids.length === 0) return new Map();
    const accountIds = await trackedAccountIds(workspaceId);
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("posts")
      .select(CITE_COLS)
      .in("id", ids)
      .in("account_id", accountIds.length ? accountIds : [NO_ROWS_SENTINEL]);
    if (error || !data) return new Map();
    return new Map((data as Row[]).map((r) => [r.id, toCard(r)]));
  } catch {
    return new Map();
  }
}
