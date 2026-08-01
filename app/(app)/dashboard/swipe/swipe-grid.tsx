"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle } from "lucide-react";
import { PostCard } from "@/components/post-card";
import type { WritableLibrary } from "@/lib/shared-bookmarks";
import type { SwipePost } from "@/lib/swipe-query";
import { LoadingPixels } from "@/components/ui/loading-state";

// Desktop infinite-scroll grid for the swipe feed. The server renders
// page 0 and hands it here with the active filter query string (so the
// client can fetch subsequent pages from GET /api/swipe-posts with the
// same filters). A sentinel near the bottom triggers the next page.
//
// Each page is enriched server-side identically (same fetchSwipePage),
// so we just render PostCard with the post.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = any;

export function SwipeGrid({
  initialPosts,
  initialNextOffset,
  query,
  clients,
  libraries,
}: {
  initialPosts: SwipePost[];
  initialNextOffset: number | null;
  // The swipe page's current filter params as a query string fragment
  // (e.g. "category=ai&sort=reactions"), WITHOUT offset. We append offset.
  query: string;
  clients: Client[];
  libraries?: WritableLibrary[];
}) {
  const [posts, setPosts] = useState<SwipePost[]>(initialPosts);
  const [nextOffset, setNextOffset] = useState<number | null>(initialNextOffset);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);

  const loadMore = useCallback(async () => {
    if (loadingRef.current || nextOffset === null) return;
    loadingRef.current = true;
    setLoading(true);
    setFailed(false);
    try {
      const qs = new URLSearchParams(query);
      qs.set("offset", String(nextOffset));
      const res = await fetch(`/api/swipe-posts?${qs.toString()}`);
      // Check res.ok BEFORE parsing: a 5xx often returns an HTML error page,
      // and res.json() would then throw an opaque "Unexpected token <" that
      // masks the real failure.
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = (await res.json()) as
        | { ok: true; posts: SwipePost[]; nextOffset: number | null }
        | { ok: false; error: string };
      if (!data.ok) throw new Error(data.error);
      setPosts((prev) => {
        // Dedupe by id across page boundaries.
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...data.posts.filter((p) => !seen.has(p.id))];
      });
      setNextOffset(data.nextOffset);
    } catch {
      // Surface an inline retry instead of silently swallowing. Crucially this
      // also unmounts the IntersectionObserver sentinel (below), stopping it
      // from re-firing loadMore in a tight loop against a failing endpoint.
      setFailed(true);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [nextOffset, query]);

  useEffect(() => {
    const el = sentinelRef.current;
    // Don't auto-observe while in a failed state — the user retries explicitly.
    if (!el || nextOffset === null || failed) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: "800px 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [loadMore, nextOffset, failed]);

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4 mt-3">
        {posts.map((p, i) => (
          <PostCard
            key={p.id}
            // PostCard's PostRow shape is a structural subset of SwipePost.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            post={p as any}
            clients={clients ?? []}
            libraries={libraries}
            priority={i < 2}
          />
        ))}
      </div>

      {nextOffset !== null && (
        <div ref={sentinelRef} className="flex justify-center py-8">
          {loading && <LoadingPixels />}
          {failed && !loading && (
            <button
              type="button"
              onClick={loadMore}
              className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <AlertCircle className="h-4 w-4" />
              Couldn&apos;t load more — retry
            </button>
          )}
        </div>
      )}
      {nextOffset === null && posts.length > 0 && (
        <p className="py-8 text-center text-xs text-muted-foreground">
          You&apos;ve seen all {posts.length} post{posts.length === 1 ? "" : "s"}
        </p>
      )}
    </>
  );
}
