"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition, useCallback, type ComponentType } from "react";
import {
  MessageSquare,
  FileText,
  Palette,
  ListChecks,
  Settings,
  Bookmark,
  AudioLines,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ClaudeIcon } from "@/components/claude-icon";
import { SwipeInIcon } from "@/components/swipein-icon";

type NavItem = {
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
      { href: "/dashboard/drafts", label: "Drafts", icon: FileText },
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
      { href: "/dashboard/branding", label: "Branding", icon: Palette },
      { href: "/dashboard/settings", label: "Settings", icon: Settings },
    ],
  },
];

export function SideNav({
  badges,
  collapsed = false,
}: {
  badges?: Record<string, number>;
  // Icon-rail mode: hide section headers + labels, center icons, and show a
  // badge as a small dot instead of a count.
  collapsed?: boolean;
}) {
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
          {/* Section header — hidden in the collapsed icon rail. A spacer keeps
              the groups visually separated without the text. */}
          {collapsed ? (
            <div className="h-2" />
          ) : (
            <div className="px-3 pb-1 text-xs font-medium text-muted-foreground/70">
              {section.label}
            </div>
          )}
          <div className="flex flex-col gap-px">
            {section.items.map((n) => {
              const active =
                n.href === "/dashboard"
                  ? effectivePath === "/dashboard"
                  : effectivePath.startsWith(n.href);
              const Icon = n.icon;
              const loading = isPending && pendingHref === n.href;
              const hasBadge = !!badges?.[n.href];
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  prefetch
                  onClick={(e) => onNavigate(e, n.href)}
                  title={collapsed ? n.label : undefined}
                  className={cn(
                    "group relative flex items-center rounded-lg text-sm transition-colors duration-100",
                    collapsed ? "justify-center px-2 py-2" : "gap-3 px-3 py-2",
                    active
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                    loading && "opacity-90",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {!collapsed && (
                    <span className="truncate flex-1">{n.label}</span>
                  )}
                  {hasBadge &&
                    (collapsed ? (
                      // Dot indicator on the icon when the rail is collapsed.
                      <span
                        className="absolute top-1 right-1 h-2 w-2 rounded-full bg-primary"
                        aria-label={`${badges![n.href]} pending`}
                      />
                    ) : (
                      <span
                        className="ml-auto h-4 min-w-4 px-1 rounded-full bg-primary text-background text-[10px] font-semibold inline-flex items-center justify-center"
                        aria-label={`${badges![n.href]} pending`}
                      >
                        {badges![n.href]}
                      </span>
                    ))}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
