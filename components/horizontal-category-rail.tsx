"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

type HorizontalCategoryRailProps = {
  children: React.ReactNode;
  className?: string;
};

/**
 * A compact horizontal category strip with explicit overflow controls.
 *
 * The old no-scrollbar rail hid the only clue that more categories existed.
 * These edge controls appear only when there is hidden content and update as
 * the user scrolls, resizes the window, or changes the category list.
 */
export function HorizontalCategoryRail({
  children,
  className,
}: HorizontalCategoryRailProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateOverflow = useCallback(() => {
    const rail = railRef.current;
    if (!rail) return;
    const maxScrollLeft = rail.scrollWidth - rail.clientWidth;
    setCanScrollLeft(rail.scrollLeft > 2);
    setCanScrollRight(maxScrollLeft - rail.scrollLeft > 2);
  }, []);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;

    updateOverflow();
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(rail);
    rail.addEventListener("scroll", updateOverflow, { passive: true });

    return () => {
      observer.disconnect();
      rail.removeEventListener("scroll", updateOverflow);
    };
  }, [children, updateOverflow]);

  function scroll(direction: -1 | 1) {
    const rail = railRef.current;
    if (!rail) return;
    rail.scrollLeft += direction * Math.max(180, rail.clientWidth * 0.7);
  }

  return (
    <div className="flex min-w-0 flex-1 items-stretch">
      {canScrollLeft && (
        <button
          type="button"
          onClick={() => scroll(-1)}
          aria-label="Show previous categories"
          className="grid w-7 shrink-0 place-items-center border-r border-border/60 text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
      )}
      <div
        ref={railRef}
        className={cn(
          "flex min-w-0 flex-1 gap-1 overflow-x-auto no-scrollbar py-0.5 text-[12px]",
          className,
        )}
      >
        {children}
      </div>

      {canScrollRight && (
        <button
          type="button"
          onClick={() => scroll(1)}
          aria-label="Show more categories"
          className="grid w-7 shrink-0 place-items-center border-l border-border/60 text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
