"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Flame, FileText, Users, ListChecks, Settings, DollarSign } from "lucide-react";
import { cn } from "@/lib/utils";

const nav = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/swipe", label: "Swipe File", icon: Flame },
  { href: "/templates", label: "Templates", icon: FileText },
  { href: "/clients", label: "Clients", icon: Users },
  { href: "/accounts", label: "Accounts", icon: ListChecks },
  { href: "/costs", label: "Costs", icon: DollarSign },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function SideNav() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-0.5">
      {nav.map((n) => {
        const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
        const Icon = n.icon;
        return (
          <Link
            key={n.href}
            href={n.href}
            className={cn(
              "group relative flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg transition-colors",
              active
                ? "bg-accent text-accent-foreground font-medium"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            {active && <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r-full bg-primary" />}
            <Icon className={cn("h-4 w-4 transition-colors", active ? "text-primary" : "text-muted-foreground/70 group-hover:text-foreground")} />
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}
