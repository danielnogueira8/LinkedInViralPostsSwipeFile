"use client";

import { useEffect, useState } from "react";

type NavBadges = Record<string, number>;

let pendingBadgesPromise: Promise<NavBadges> | null = null;

function loadNavBadges(): Promise<NavBadges> {
  pendingBadgesPromise ??= fetch("/api/shared-bookmarks/pending-count")
    .then((res) => res.json())
    .then((data): NavBadges => {
      if (!data?.ok || typeof data.count !== "number") return {};
      return data.count > 0
        ? { "/dashboard/bookmarks": data.count as number }
        : {};
    })
    .catch((): NavBadges => ({}));
  return pendingBadgesPromise;
}

export function useNavBadges(initialBadges?: NavBadges) {
  const [badges, setBadges] = useState<NavBadges>(initialBadges ?? {});

  useEffect(() => {
    let cancelled = false;
    loadNavBadges().then((next) => {
      if (!cancelled) setBadges(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return badges;
}
