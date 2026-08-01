"use client";

import { useEffect, useState } from "react";
import {
  invalidateAgentInboxRequest,
  loadAgentInbox,
} from "./agent-inbox-client";
type NavBadges = Record<string, number>;

// Navigation badges are fetched client-side once and memoized at module scope
// so desktop and mobile navigation share one request. Mutations can invalidate
// that cache because router.refresh only re-runs server components, not this
// client fetch.
let pendingBadgesPromise: Promise<NavBadges> | null = null;

// Window event mounted navs listen for, so an invalidation refreshes a badge
// that's already on screen (not just the next mount).
const NAV_BADGES_INVALIDATE_EVENT = "swipein:nav-badges-invalidate";

function fetchNavBadges(): Promise<NavBadges> {
  return Promise.all([
    fetch("/api/shared-bookmarks/pending-count", { method: "POST" })
      .then((res) => res.json())
      .catch(() => ({})),
    loadAgentInbox().catch(() => null),
  ])
    .then(([shared, agent]): NavBadges => {
      const next: NavBadges = {};
      if (shared?.ok && typeof shared.count === "number" && shared.count > 0) {
        next["/dashboard/swipe"] = shared.count;
      }
      if (agent?.ok) {
        const count = Array.isArray(agent.active) ? agent.active.length : 0;
        if (count > 0) next["/dashboard/agent"] = count;
      }
      return next;
    })
    .catch((): NavBadges => ({}));
}

function loadNavBadges(): Promise<NavBadges> {
  pendingBadgesPromise ??= fetchNavBadges();
  return pendingBadgesPromise;
}

// Clear the memoized badge counts and tell every mounted nav to refetch after a
// mutation changes one of them. Safe to call from any client component.
export function invalidateNavBadges(): void {
  pendingBadgesPromise = null;
  invalidateAgentInboxRequest();
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

    // Re-fetch when a mutation invalidates a count.
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
