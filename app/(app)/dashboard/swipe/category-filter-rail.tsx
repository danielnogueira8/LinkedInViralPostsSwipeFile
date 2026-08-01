"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { HorizontalCategoryRail } from "@/components/horizontal-category-rail";
import { filterDotClass, filterPillClass } from "@/components/filter-ui";

type CategoryLink = {
  href: string;
  id: string;
  label: string;
};

type PendingSelection = {
  href: string;
  id: string | null;
};

export function CategoryFilterRail({
  activeCategoryId,
  allHref,
  categories,
}: {
  activeCategoryId: string | null;
  allHref: string;
  categories: CategoryLink[];
}) {
  const router = useRouter();
  const [pendingSelection, setPendingSelection] = useState<PendingSelection | null>(null);
  const [isPending, startTransition] = useTransition();
  // A pending `null` means "All", so it must not fall through to the current
  // category the way nullish coalescing would.
  const assumedCategoryId = pendingSelection
    ? pendingSelection.id
    : activeCategoryId;

  // A completed navigation supplies a new activeCategoryId from the server.
  // Clear the matching temporary selection once the transition settles. This
  // guarded render-time adjustment mirrors the app nav's pending-state logic
  // and avoids an extra effect render.
  if (
    pendingSelection &&
    pendingSelection.id === activeCategoryId &&
    !isPending
  ) {
    setPendingSelection(null);
  }

  function navigate(
    event: { preventDefault(): void },
    selection: PendingSelection,
  ) {
    event.preventDefault();
    setPendingSelection(selection);
    startTransition(() => {
      router.push(selection.href, { scroll: false });
    });
  }

  function categoryLink(
    id: string | null,
    href: string,
    label: React.ReactNode,
  ) {
    const assumed = assumedCategoryId === id;
    const loading = isPending && pendingSelection?.id === id;
    return (
      <Link
        href={href}
        scroll={false}
        aria-current={assumed ? "page" : undefined}
        aria-busy={loading || undefined}
        className={filterPillClass(assumed)}
        onNavigate={(event) => navigate(event, { href, id })}
      >
        <span aria-hidden className={filterDotClass(assumed)} />
        {label}
        {loading && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
      </Link>
    );
  }

  return (
    <>
      <HorizontalCategoryRail>
        {categoryLink(
          null,
          allHref,
          <>
            All <span className="ml-1 text-[10px] opacity-60">{categories.length}</span>
          </>,
        )}
        {categories.map((category) => (
          <span key={category.id} className="contents">
            {categoryLink(category.id, category.href, category.label)}
          </span>
        ))}
      </HorizontalCategoryRail>
    </>
  );
}
