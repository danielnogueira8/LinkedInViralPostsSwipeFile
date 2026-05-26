"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { PostCard } from "@/components/post-card";
import type { WritableLibrary } from "@/lib/shared-bookmarks";
import type { SwipePost } from "@/lib/swipe-query";

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
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);

  const loadMore = useCallback(async () => {
    if (loadingRef.current || nextOffset === null) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const qs = new URLSearchParams(query);
      qs.set("offset", String(nextOffset));
      const res = await fetch(`/api/swipe-posts?${qs.toString()}`);
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
      // Leave the sentinel mounted; a later scroll re-triggers the fetch.
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [nextOffset, query]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || nextOffset === null) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: "800px 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [loadMore, nextOffset]);

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
          {loading && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
        </div>
      )}
    </>
  );
}
