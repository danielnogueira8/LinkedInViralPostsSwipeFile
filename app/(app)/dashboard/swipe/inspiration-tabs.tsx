"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, useTransition, type MouseEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Bookmark } from "lucide-react";
import { segmentedPanelClass, segmentedPanelItemClass } from "@/components/app-surface";
import { SwipeInIcon } from "@/components/swipein-icon";
import { cn } from "@/lib/utils";
import { hrefWithPersistedFilters } from "@/components/persisted-filter-state";

const TABS = [
  {
    key: "swipe" as const,
    href: "/dashboard/swipe",
    label: "Swipe File",
    description: "all source posts",
    icon: SwipeInIcon,
  },
  {
    key: "bookmarks" as const,
    href: "/dashboard/swipe?tab=bookmarks",
    label: "Bookmarks",
    description: "saved source posts",
    icon: Bookmark,
  },
];

export function InspirationTabs({
  active,
  action,
}: {
  active: "swipe" | "bookmarks";
  action?: ReactNode;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pendingActive, setPendingActive] = useState<"swipe" | "bookmarks" | null>(null);
  const effectiveActive = pendingActive && isPending ? pendingActive : active;

  const prefetchTab = useCallback(
    (href: string) => {
      router.prefetch(href);
    },
    [router],
  );

  useEffect(() => {
    for (const tab of TABS) {
      if (tab.key !== active) prefetchTab(tab.href);
    }
  }, [active, prefetchTab]);

  const onNavigate = useCallback(
    (
      e: MouseEvent<HTMLAnchorElement>,
      tab: (typeof TABS)[number],
    ) => {
      if (
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      ) {
        return;
      }
      const targetHref = hrefWithPersistedFilters(tab.href);
      prefetchTab(targetHref);
      if (tab.key === active) return;
      e.preventDefault();
      setPendingActive(tab.key);
      startTransition(() => {
        router.push(targetHref);
      });
    },
    [active, prefetchTab, router],
  );

  if (pendingActive && pendingActive === active && !isPending) {
    setPendingActive(null);
  }

  return (
    <div className={segmentedPanelClass("lg:flex-row lg:items-center")}>
      <div className="flex min-w-0 flex-1 flex-wrap gap-2">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const selected = effectiveActive === tab.key;
          return (
            <Link
              key={tab.key}
              href={tab.href}
              prefetch
              onClick={(e) => onNavigate(e, tab)}
              onFocus={() => prefetchTab(tab.href)}
              onPointerEnter={() => prefetchTab(tab.href)}
              className={segmentedPanelItemClass(selected)}
              aria-current={selected ? "page" : undefined}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">{tab.label}</span>
                <span
                  className={cn(
                    "block truncate text-[11px]",
                    selected ? "text-background/70" : "text-muted-foreground",
                  )}
                >
                  {tab.description}
                </span>
              </span>
            </Link>
          );
        })}
      </div>
      {action && (
        <div className="flex shrink-0 justify-end pt-1 lg:ml-1 lg:pt-0">
          {action}
        </div>
      )}
    </div>
  );
}
