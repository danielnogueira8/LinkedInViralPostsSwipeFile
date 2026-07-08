import Link from "next/link";
import type { ReactNode } from "react";
import { Bookmark } from "lucide-react";
import { SwipeInIcon } from "@/components/swipein-icon";
import { cn } from "@/lib/utils";

export function InspirationTabs({
  active,
  action,
}: {
  active: "swipe" | "bookmarks";
  action?: ReactNode;
}) {
  const tabs = [
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

  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-border/60 bg-card/80 p-1 shadow-soft lg:flex-row lg:items-center">
      <div className="flex min-w-0 flex-1 flex-wrap gap-2">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const selected = active === tab.key;
          return (
            <Link
              key={tab.key}
              href={tab.href}
              className={cn(
                "flex min-w-[11rem] flex-1 items-center gap-2 rounded-xl px-3 py-2.5 text-left transition-colors",
                selected
                  ? "bg-foreground text-background shadow-soft"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
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
        <div className="flex shrink-0 justify-end border-border/60 pt-1 lg:border-l lg:pl-2 lg:pt-0">
          {action}
        </div>
      )}
    </div>
  );
}
