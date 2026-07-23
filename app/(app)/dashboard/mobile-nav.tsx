"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition, useCallback } from "react";
import { MoreHorizontal, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { hrefWithPersistedFilters } from "@/components/persisted-filter-state";
import {
  MOBILE_MORE_SECTIONS,
  MOBILE_PRIMARY_PATHS,
} from "@/lib/mobile-navigation-policy";
import { NAV_BY_HREF } from "./nav-destinations";
import { useNavBadges } from "./nav-badges";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

// The bottom bar follows the product lifecycle: review Your Agent, create in
// Cowork, find proven inspiration in Swipe, manage drafts in Posts, and return
// to saved references in Bookmarks. System destinations stay grouped behind
// More. Items resolve through the shared nav-destinations module.
const PRIMARY = MOBILE_PRIMARY_PATHS.map((path) => NAV_BY_HREF[path]);
const MORE = MOBILE_MORE_SECTIONS.flatMap((section) =>
  section.paths.map((path) => NAV_BY_HREF[path]),
);

export function MobileNav({ badges: initialBadges }: { badges?: Record<string, number> }) {
  const pathname = usePathname();
  const router = useRouter();
  const badges = useNavBadges(initialBadges);
  const [isPending, startTransition] = useTransition();
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);

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
        return;
      }
      setMoreOpen(false);
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

  if (pendingHref && pendingHref === pathname && !isPending) {
    setPendingHref(null);
  }

  const effectivePath = pendingHref ?? pathname;

  const isActive = useCallback(
    (href: string) =>
      href === "/dashboard"
        ? effectivePath === "/dashboard"
        : effectivePath.startsWith(href),
    [effectivePath],
  );

  // Sum of badges that live on items hidden behind "More" — surfaced on the
  // More button so a pending action in a hidden tab is still discoverable.
  const moreBadge = MORE.reduce((n, m) => n + (badges?.[m.href] ?? 0), 0);
  // Is one of the hidden destinations the current page? Then "More" is active.
  const moreActive = MORE.some((m) => isActive(m.href));

  return (
    <>
      <Dialog open={moreOpen} onOpenChange={setMoreOpen}>
        <DialogContent
          showCloseButton={false}
          className="lg:hidden !fixed !inset-x-0 !bottom-0 !top-auto !left-0 !w-full !max-w-none !translate-x-0 !translate-y-0 gap-0 rounded-t-2xl rounded-b-none border-x-0 border-b-0 bg-sidebar p-0 shadow-soft-lg pb-[env(safe-area-inset-bottom)] data-open:slide-in-from-bottom data-closed:slide-out-to-bottom duration-200 ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:animate-none"
        >
            <div className="flex items-center justify-between px-4 pt-3 pb-1">
              <DialogTitle className="text-sm font-medium text-foreground">
                More navigation
              </DialogTitle>
              <button
                type="button"
                onClick={() => setMoreOpen(false)}
                className="grid size-10 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                aria-label="Close menu"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="max-h-[75dvh] overflow-y-auto px-2 pb-3">
              {MOBILE_MORE_SECTIONS.map((section) => (
                <section key={section.label} aria-label={section.label}>
                  <h3 className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/75">
                    {section.label}
                  </h3>
                  <ul className="grid grid-cols-1">
                    {section.paths.map((path) => {
                      const m = NAV_BY_HREF[path];
                      const active = isActive(m.href);
                      const Icon = m.icon;
                      return (
                        <li key={m.href}>
                          <Link
                            href={m.href}
                            prefetch
                            onClick={(e) => onNavigate(e, m.href)}
                            aria-current={active ? "page" : undefined}
                            title={m.tooltip ?? m.label}
                            className={cn(
                              "flex items-center gap-3 rounded-lg px-3 py-3 text-sm transition-colors",
                              active
                                ? "bg-accent/60 text-foreground font-medium"
                                : "text-muted-foreground hover:bg-muted hover:text-foreground",
                            )}
                          >
                            <Icon
                              className={cn(
                                "h-5 w-5 shrink-0",
                                active && "text-primary",
                              )}
                            />
                            <span className="flex-1">{m.label}</span>
                            {badges?.[m.href] ? (
                              <span
                                className="h-5 min-w-5 px-1.5 rounded-full bg-primary text-background text-[11px] font-semibold inline-flex items-center justify-center"
                                aria-label={`${badges[m.href]} pending`}
                              >
                                {badges[m.href]}
                              </span>
                            ) : null}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
        </DialogContent>
      </Dialog>

      <nav
        className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-sidebar/95 backdrop-blur border-t border-border pb-[env(safe-area-inset-bottom)]"
        aria-label="Primary"
      >
        <ul className="grid grid-cols-6">
          {PRIMARY.map((n) => {
            const active = isActive(n.href);
            const Icon = n.icon;
            return (
              <li key={n.href}>
                <Link
                  href={n.href}
                  prefetch
                  onClick={(e) => onNavigate(e, n.href)}
                  aria-current={active ? "page" : undefined}
                  title={n.tooltip ?? n.label}
                  className={cn(
                    "flex flex-col items-center justify-center gap-0.5 py-2.5 text-[11px] leading-tight transition-colors",
                    active
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <div className="relative">
                    <Icon className={cn("h-5 w-5", active && "text-primary")} />
                    {badges?.[n.href] ? (
                      <span
                        className="absolute -top-1 -right-2 h-4 min-w-4 px-1 rounded-full bg-primary text-background text-[10px] font-semibold inline-flex items-center justify-center"
                        aria-label={`${badges[n.href]} pending`}
                      >
                        {badges[n.href]}
                      </span>
                    ) : null}
                  </div>
                  <span className="truncate max-w-full px-0.5">{n.shortLabel ?? n.label}</span>
                </Link>
              </li>
            );
          })}
          {/* "More" opens the overflow sheet. */}
          <li>
            <button
              type="button"
              onClick={() => setMoreOpen((v) => !v)}
              aria-haspopup="dialog"
              aria-expanded={moreOpen}
              title="Open more navigation destinations."
              className={cn(
                "w-full flex flex-col items-center justify-center gap-0.5 py-2.5 text-[11px] leading-tight transition-colors",
                moreOpen || moreActive
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <div className="relative">
                <MoreHorizontal
                  className={cn("h-5 w-5", (moreOpen || moreActive) && "text-primary")}
                />
                {moreBadge > 0 ? (
                  <span
                    className="absolute -top-1 -right-2 h-4 min-w-4 px-1 rounded-full bg-primary text-background text-[10px] font-semibold inline-flex items-center justify-center"
                    aria-label={`${moreBadge} pending`}
                  >
                    {moreBadge}
                  </span>
                ) : null}
              </div>
              <span className="truncate max-w-full px-0.5">More</span>
            </button>
          </li>
        </ul>
      </nav>
    </>
  );
}
