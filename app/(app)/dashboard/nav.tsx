"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Flame, FileText, Users, ListChecks, Settings, DollarSign } from "lucide-react";
import { cn } from "@/lib/utils";

const nav = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/dashboard/swipe", label: "Swipe File", icon: Flame },
  { href: "/dashboard/templates", label: "Templates", icon: FileText },
  { href: "/dashboard/clients", label: "Clients", icon: Users },
  { href: "/dashboard/accounts", label: "Accounts", icon: ListChecks },
  { href: "/dashboard/costs", label: "Costs", icon: DollarSign },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

export function SideNav() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-px">
      <div className="px-3 pb-2 text-xs text-muted-foreground">
        Workspace
      </div>
      {nav.map((n) => {
        const active = n.href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(n.href);
        const Icon = n.icon;
        return (
          <Link
            key={n.href}
            href={n.href}
            className={cn(
              "group flex items-center gap-3 px-3 py-2 text-sm rounded-lg transition-colors duration-100",
              active
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
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
