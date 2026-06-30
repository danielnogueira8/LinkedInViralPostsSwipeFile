"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition, useCallback, type ComponentType } from "react";
import {
  MessageSquare,
  FileText,
  ListChecks,
  Settings,
  Bookmark,
  AudioLines,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ClaudeIcon } from "@/components/claude-icon";
import { SwipeInIcon } from "@/components/swipein-icon";

export type NavItem = {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
};

type NavSection = {
  label: string;
  items: NavItem[];
};

const nav: NavSection[] = [
  {
    label: "Workspace",
    items: [
      { href: "/dashboard", label: "Chat", icon: MessageSquare },
      { href: "/dashboard/posts", label: "Posts", icon: FileText },
    ],
  },
  {
    label: "Content",
    items: [
      { href: "/dashboard/swipe", label: "Swipe File", icon: SwipeInIcon },
      { href: "/dashboard/bookmarks", label: "Bookmarks", icon: Bookmark },
      { href: "/dashboard/templates", label: "Templates", icon: FileText },
    ],
  },
  {
    label: "Tracked Accounts",
    items: [
      { href: "/dashboard/accounts", label: "Tracked Accounts", icon: ListChecks },
    ],
  },
  {
    label: "Tools",
    items: [{ href: "/dashboard/claude", label: "Claude Workflows", icon: ClaudeIcon }],
  },
  {
    label: "Account",
    items: [
      { href: "/dashboard/voice", label: "Voice", icon: AudioLines },
      { href: "/dashboard/skills", label: "Custom Skills", icon: Zap },
      { href: "/dashboard/settings", label: "Settings", icon: Settings },
    ],
  },
];

// Flat list of all nav destinations — the command palette (Cmd-K) reuses this so
// jump targets stay in sync with the sidebar.
export const NAV_DESTINATIONS: NavItem[] = nav.flatMap((s) => s.items);

export function SideNav({ badges }: { badges?: Record<string, number> }) {
  const pathname = usePathname();
  const router = useRouter();
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
      setPendingHref(href);
      startTransition(() => {
        router.push(href);
      });
    },
    [pathname, router],
  );

  // Once the URL catches up, clear the optimistic highlight.
  if (pendingHref && pendingHref === pathname && !isPending) {
    // setState in render is fine when guarded; avoids an extra effect tick.
    setPendingHref(null);
  }

  const effectivePath = pendingHref ?? pathname;

  return (
    <nav className="flex flex-col gap-4">
      {nav.map((section) => (
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
                  className={cn(
                    "group flex items-center gap-3 px-3 py-2 text-sm rounded-lg transition-colors duration-100",
                    active
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                    loading && "opacity-90",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="truncate flex-1">{n.label}</span>
                  {badges?.[n.href] ? (
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
