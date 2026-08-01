"use client";

import { Search, X } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

type SearchFieldProps = Omit<
  React.ComponentProps<"input">,
  "type"
> & {
  containerClassName?: string;
  onClear?: () => void;
};

function SearchField({
  className,
  containerClassName,
  onClear,
  value,
  ref,
  ...props
}: SearchFieldProps) {
  const hasValue =
    typeof value === "string" || typeof value === "number"
      ? String(value).length > 0
      : Array.isArray(value) && value.length > 0;

  return (
    <div
      data-slot="search-field"
      className={cn("group/search relative min-w-0", containerClassName)}
    >
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground transition-colors group-focus-within/search:text-foreground"
      />
      <input
        ref={ref}
        type="search"
        value={value}
        className={cn(
          "h-10 w-full min-w-0 rounded-xl border border-border bg-background pl-9 text-sm text-foreground shadow-[inset_0_1px_0_rgb(255_255_255_/_0.7)] outline-none",
          "placeholder:text-muted-foreground transition-[border-color,box-shadow,background-color] duration-150",
          "hover:border-input focus-visible:border-ring/45 focus-visible:ring-3 focus-visible:ring-ring/15",
          "[&::-webkit-search-cancel-button]:appearance-none",
          onClear && hasValue ? "pr-10" : "pr-3",
          className,
        )}
        {...props}
      />
      {onClear && hasValue ? (
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear search"
          className="absolute right-1 top-1 grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export { SearchField };
