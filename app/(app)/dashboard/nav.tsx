"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition, useCallback, type ComponentType } from "react";
import {
  LayoutDashboard,
  Flame,
  FileText,
  Users,
  ListChecks,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";

type NavItem = {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
};

const nav: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/dashboard/swipe", label: "Swipe File", icon: Flame },
  { href: "/dashboard/templates", label: "Templates", icon: FileText },
  { href: "/dashboard/clients", label: "Clients", icon: Users },
  { href: "/dashboard/accounts", label: "Accounts", icon: ListChecks },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

export function SideNav() {
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
    <nav className="flex flex-col gap-px">
      <div className="px-3 pb-2 text-xs text-muted-foreground">Workspace</div>
      {nav.map((n) => {
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
            <span className="truncate">{n.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
