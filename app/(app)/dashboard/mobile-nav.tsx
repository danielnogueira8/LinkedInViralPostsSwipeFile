"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition, useCallback, useEffect, type ComponentType } from "react";
import {
  Handshake,
  FileText,
  Gift,
  ListChecks,
  Settings,
  Bookmark,
  AudioLines,
  Zap,
  Fingerprint,
  MoreHorizontal,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ClaudeIcon } from "@/components/claude-icon";
import { SwipeInIcon } from "@/components/swipein-icon";
import { hrefWithPersistedFilters } from "@/components/persisted-filter-state";

type NavItem = {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  tooltip?: string;
};

// The four most-used destinations sit in the bottom bar; everything else
// lives behind "More". Five comfortable tap targets beats eight cramped ones
// (the old grid-cols-8 gave each item ~45px on a phone — labels truncated and
// icons collided). Bookmarks stays primary because it's where saves land and
// it carries the shared-invite badge.
const PRIMARY: NavItem[] = [
  { href: "/dashboard", label: "Cowork", icon: Handshake, tooltip: "Chat with the writing agent and run weekly batches." },
  { href: "/dashboard/swipe", label: "Swipe", icon: SwipeInIcon, tooltip: "Browse source posts to model or save." },
  { href: "/dashboard/bookmarks", label: "Bookmarks", icon: Bookmark, tooltip: "Saved swipe-file posts and shared libraries." },
  { href: "/dashboard/templates", label: "Templates", icon: FileText, tooltip: "Reusable content templates for posts and hooks." },
  { href: "/dashboard/creator-styles", label: "Creator Styles", icon: Fingerprint, tooltip: "Reusable writing-style profiles from creators you track." },
];

const MORE: NavItem[] = [
  { href: "/dashboard/posts", label: "Posts", icon: FileText, tooltip: "Review, edit, schedule, and track your draft posts." },
  { href: "/dashboard/lead-magnets", label: "Lead Magnets", icon: Gift, tooltip: "Create and share markdown resources for lead-magnet posts." },
  { href: "/dashboard/voice", label: "Voice", icon: AudioLines, tooltip: "Your writing profile and voice preferences." },
  { href: "/dashboard/skills", label: "Custom Skills", icon: Zap, tooltip: "Instructions and examples that shape how drafts are written." },
  { href: "/dashboard/accounts", label: "Tracked Creators", icon: ListChecks, tooltip: "Creators the app monitors for new high-performing posts." },
  { href: "/dashboard/claude", label: "Claude Workflows", icon: ClaudeIcon, tooltip: "Reusable AI workflows for content tasks." },
  { href: "/dashboard/settings", label: "Settings", icon: Settings, tooltip: "Workspace settings and publishing connections." },
];

export function MobileNav({ badges }: { badges?: Record<string, number> }) {
  const pathname = usePathname();
  const router = useRouter();
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

  // Lock body scroll while the sheet is open so the page behind doesn't move.
  useEffect(() => {
    if (!moreOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [moreOpen]);

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
      {/* Backdrop + bottom sheet for the overflow nav items. */}
      {moreOpen && (
        <div
          className="lg:hidden fixed inset-0 z-50"
          role="dialog"
          aria-modal="true"
          aria-label="More navigation"
        >
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setMoreOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute inset-x-0 bottom-0 rounded-t-2xl bg-sidebar border-t border-border/60 shadow-soft-lg pb-[env(safe-area-inset-bottom)] animate-in slide-in-from-bottom duration-200">
            <div className="flex items-center justify-between px-4 pt-3 pb-1">
              <span className="text-sm font-medium text-foreground">More</span>
              <button
                type="button"
                onClick={() => setMoreOpen(false)}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                aria-label="Close menu"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <ul className="grid grid-cols-1 px-2 pb-3">
              {MORE.map((m) => {
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
                      <Icon className={cn("h-5 w-5 shrink-0", active && "text-primary")} />
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
          </div>
        </div>
      )}

      <nav
        className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-sidebar/95 backdrop-blur border-t border-border/60 pb-[env(safe-area-inset-bottom)]"
        aria-label="Primary"
      >
        <ul className="grid grid-cols-5">
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
                  <span className="truncate max-w-full px-0.5">{n.label}</span>
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
