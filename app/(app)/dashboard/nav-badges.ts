"use client";

import { useEffect, useState } from "react";

type NavBadges = Record<string, number>;

// The pending-invite badge is fetched client-side once and memoized at module
// scope so every nav instance (desktop + mobile) shares one request. But that
// memoization used to be permanent: accepting/declining an invite left the
// badge showing the stale count until a full page reload, because router.refresh
// only re-runs server components — not this client fetch. invalidateNavBadges()
// clears the cache AND signals mounted navs to refetch immediately.
let pendingBadgesPromise: Promise<NavBadges> | null = null;

// Window event mounted navs listen for, so an invalidation refreshes a badge
// that's already on screen (not just the next mount).
const NAV_BADGES_INVALIDATE_EVENT = "swipein:nav-badges-invalidate";

function fetchNavBadges(): Promise<NavBadges> {
  return fetch("/api/shared-bookmarks/pending-count")
    .then((res) => res.json())
    .then((data): NavBadges => {
      if (!data?.ok || typeof data.count !== "number") return {};
      return data.count > 0 ? { "/dashboard/swipe": data.count as number } : {};
    })
    .catch((): NavBadges => ({}));
}

function loadNavBadges(): Promise<NavBadges> {
  pendingBadgesPromise ??= fetchNavBadges();
  return pendingBadgesPromise;
}

// Clear the memoized badge count and tell every mounted nav to refetch. Call
// after a mutation that changes the pending-invite count (accept / decline /
// revoke). Safe to call from any client component.
export function invalidateNavBadges(): void {
  pendingBadgesPromise = null;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(NAV_BADGES_INVALIDATE_EVENT));
  }
}

export function useNavBadges(initialBadges?: NavBadges) {
  const [badges, setBadges] = useState<NavBadges>(initialBadges ?? {});

  useEffect(() => {
    let cancelled = false;
    loadNavBadges().then((next) => {
      if (!cancelled) setBadges(next);
    });

    // Re-fetch when something invalidates the count (invite accepted, etc.).
    // The invalidator already cleared the memo, so this load hits the network.
    const onInvalidate = () => {
      loadNavBadges().then((next) => {
        if (!cancelled) setBadges(next);
      });
    };
    window.addEventListener(NAV_BADGES_INVALIDATE_EVENT, onInvalidate);
    return () => {
      cancelled = true;
      window.removeEventListener(NAV_BADGES_INVALIDATE_EVENT, onInvalidate);
    };
  }, []);

  return badges;
}
