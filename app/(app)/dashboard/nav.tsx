"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition, useCallback } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { hrefWithPersistedFilters } from "@/components/persisted-filter-state";
import { NAV_SECTIONS } from "./nav-destinations";
import { useNavBadges } from "./nav-badges";

export function SideNav({ badges: initialBadges }: { badges?: Record<string, number> }) {
  const pathname = usePathname();
  const router = useRouter();
  const badges = useNavBadges(initialBadges);
  const [isPending, startTransition] = useTransition();
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  // Intercept clicks: paint the clicked item active immediately (optimistic),
  // then let React Transitions stream in the new page. Combined with the
  // route's loading.tsx, this makes nav feel instant even on slow servers.
  const onNavigate = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
      if (
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      ) {
        return; // let the browser handle modifier-clicks / middle-clicks
      }
      if (href === pathname) return;
      e.preventDefault();
      const targetHref = hrefWithPersistedFilters(href);
      setPendingHref(href);
      startTransition(() => {
        router.push(targetHref);
      });
    },
    [pathname, router],
  );

  // Once the transition settles, clear the optimistic highlight — whether the
  // URL caught up (success) or the push failed, so a stale highlight never
  // sticks on the wrong item.
  if (pendingHref && !isPending) {
    // setState in render is fine when guarded; avoids an extra effect tick.
    setPendingHref(null);
  }

  const effectivePath = pendingHref ?? pathname;

  return (
    <nav className="flex flex-col gap-4">
      {NAV_SECTIONS.map((section) => (
        <div key={section.label}>
          <div className="px-3 pb-1 text-xs font-medium text-muted-foreground/70">
            {section.label}
          </div>
          <div className="flex flex-col gap-px">
            {section.items.map((n) => {
              const active =
                n.href === "/dashboard"
                  ? effectivePath === "/dashboard"
                  : effectivePath.startsWith(n.href);
              const Icon = n.icon;
              const loading = isPending && pendingHref === n.href;
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  prefetch
                  onClick={(e) => onNavigate(e, n.href)}
                  title={n.tooltip ?? n.label}
                  className={cn(
                    "group flex items-center gap-3 px-3 py-2 text-sm rounded-lg border transition-colors duration-100",
                    active
                      ? "bg-card border-border text-foreground shadow-soft"
                      : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="truncate flex-1">{n.label}</span>
                  {loading ? (
                    <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin text-muted-foreground" />
                  ) : badges?.[n.href] ? (
                    <span
                      className="ml-auto h-4 min-w-4 px-1 rounded-full bg-primary text-background text-[10px] font-semibold inline-flex items-center justify-center"
                      aria-label={`${badges[n.href]} pending`}
                    >
                      {badges[n.href]}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
