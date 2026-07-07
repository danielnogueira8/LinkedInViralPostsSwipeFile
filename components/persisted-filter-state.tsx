"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";

const SWIPE_FILTERS_KEY = "swipein:filters:swipe";
const BOOKMARK_FILTERS_KEY = "swipein:filters:bookmarks";

const FILTER_KEYS_BY_PATH: Record<string, string> = {
  "/dashboard/swipe": SWIPE_FILTERS_KEY,
  "/dashboard/bookmarks": BOOKMARK_FILTERS_KEY,
};

export function PersistFilterSearch({ storageKey }: { storageKey: string }) {
  const searchParams = useSearchParams();
  const query = searchParams.toString();

  useEffect(() => {
    if (!query) {
      window.sessionStorage.removeItem(storageKey);
      return;
    }
    window.sessionStorage.setItem(storageKey, query);
  }, [query, storageKey]);

  return null;
}

export function SwipeFilterPersistence() {
  return <PersistFilterSearch storageKey={SWIPE_FILTERS_KEY} />;
}

export function BookmarkFilterPersistence() {
  return <PersistFilterSearch storageKey={BOOKMARK_FILTERS_KEY} />;
}

export function hrefWithPersistedFilters(href: string): string {
  if (typeof window === "undefined") return href;
  return hrefWithStoredFilterQuery(href, (key) => window.sessionStorage.getItem(key));
}

export function hrefWithStoredFilterQuery(
  href: string,
  read: (storageKey: string) => string | null,
): string {
  const [path, query = ""] = href.split("?");
  if (query) return href;
  const key = FILTER_KEYS_BY_PATH[path];
  if (!key) return href;
  const stored = read(key);
  return stored ? `${path}?${stored}` : href;
}
