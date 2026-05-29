"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition, useCallback, type ComponentType } from "react";
import {
  LayoutDashboard,
  FileText,
  Palette,
  ListChecks,
  Settings,
  Bookmark,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ClaudeIcon } from "@/components/claude-icon";
import { SwipeInIcon } from "@/components/swipein-icon";

type NavItem = {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
};

const nav: NavItem[] = [
  { href: "/dashboard", label: "Home", icon: LayoutDashboard },
  { href: "/dashboard/swipe", label: "Swipe", icon: SwipeInIcon },
  { href: "/dashboard/bookmarks", label: "Bookmarks", icon: Bookmark },
  { href: "/dashboard/templates", label: "Templates", icon: FileText },
  { href: "/dashboard/branding", label: "Branding", icon: Palette },
  { href: "/dashboard/accounts", label: "Accounts", icon: ListChecks },
  { href: "/dashboard/claude", label: "Claude", icon: ClaudeIcon },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

export function MobileNav({ badges }: { badges?: Record<string, number> }) {
  const pathname = usePathname();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pendingHref, setPendingHref] = useState<string | null>(null);

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
      if (href === pathname) return;
      e.preventDefault();
      setPendingHref(href);
      startTransition(() => {
        router.push(href);
      });
    },
    [pathname, router],
  );

  if (pendingHref && pendingHref === pathname && !isPending) {
    setPendingHref(null);
  }

  const effectivePath = pendingHref ?? pathname;

  return (
    <nav
      className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-sidebar/95 backdrop-blur border-t border-border/60 pb-[env(safe-area-inset-bottom)]"
      aria-label="Primary"
    >
      <ul className="grid grid-cols-8">
        {nav.map((n) => {
          const active =
            n.href === "/dashboard"
              ? effectivePath === "/dashboard"
              : effectivePath.startsWith(n.href);
          const Icon = n.icon;
          return (
            <li key={n.href}>
              <Link
                href={n.href}
                prefetch
                onClick={(e) => onNavigate(e, n.href)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex flex-col items-center justify-center gap-0.5 py-2 text-[10px] leading-tight transition-colors",
                  active
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <div className="relative">
                  <Icon className={cn("h-5 w-5", active && "text-primary")} />
                  {badges?.[n.href] ? (
                    <span
                      className="absolute -top-1 -right-2 h-3.5 min-w-3.5 px-0.5 rounded-full bg-primary text-background text-[9px] font-semibold inline-flex items-center justify-center"
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
      </ul>
    </nav>
  );
}
