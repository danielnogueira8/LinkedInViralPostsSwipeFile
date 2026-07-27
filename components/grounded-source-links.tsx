"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import type { Artifact } from "@/lib/agent/contracts";
import type { CitedPost } from "@/lib/cite-resolve";
import { MAX_GROUNDED_ANSWER_RESULTS } from "@/lib/agent/evidence";
import {
  GROUNDED_SOURCE_PRESENTATION,
  verifiedLinkedInSourceUrl,
} from "@/lib/agent/grounded-source-citations";
import { InlineSourceCard } from "@/components/inline-source-card";
import { cn } from "@/lib/utils";

type RehydratedCard = { id?: unknown; postUrl?: unknown };

// A grounded source, resolved as far as its data allows: a full post card when
// the server rehydrated one (meta.card, filled by rehydrateCites on chat load),
// else just the verified LinkedIn href for a chip fallback.
type ResolvedSource = { href: string; card: CitedPost | null };

// A full CitedPost has the fields InlineSourceCard renders. rehydrateCites fills
// a complete row from the DB, but a persisted/partial meta.card (e.g. an old
// {id, postUrl} snapshot) must fall back to a chip rather than crash the card.
function isRenderableCard(card: unknown): card is CitedPost {
  if (!card || typeof card !== "object") return false;
  const c = card as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    typeof c.authorName === "string" &&
    Array.isArray(c.mediaUrls)
  );
}

function groundedSources(artifacts: Artifact[]): ResolvedSource[] {
  const seen = new Set<string>();
  const out: ResolvedSource[] = [];
  for (const artifact of artifacts) {
    if (
      artifact.kind !== "cite" ||
      artifact.meta?.presentation !== GROUNDED_SOURCE_PRESENTATION
    ) {
      continue;
    }
    const postId = artifact.meta.postId;
    const card = artifact.meta.card as (CitedPost & RehydratedCard) | undefined;
    const matches = !!card && card.id === postId;
    const rehydratedUrl = matches
      ? verifiedLinkedInSourceUrl(card!.postUrl)
      : undefined;
    const href =
      rehydratedUrl ?? verifiedLinkedInSourceUrl(artifact.meta.sourceUrl);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    // Only render a full card when the rehydrated post matches this cite's id
    // AND is a complete CitedPost; else fall back to the chip.
    out.push({
      href,
      card: matches && isRenderableCard(card) ? card : null,
    });
  }
  return out.slice(0, MAX_GROUNDED_ANSWER_RESULTS);
}

// A LinkedIn chip fallback for a source that didn't resolve to a full post card
// (e.g. a deleted / out-of-workspace id). Never drop a source silently.
function SourceChip({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:text-primary"
    >
      <ExternalLink className="h-3.5 w-3.5" aria-hidden />
      {label}
    </a>
  );
}

// One-at-a-time carousel of source cards that wraps (last → first). Prev/next
// plus a dot per card. Rendered only when there is more than one card.
function SourceCarousel({ cards }: { cards: CitedPost[] }) {
  const [index, setIndex] = useState(0);
  const count = cards.length;
  // Clamp at render time (like DocumentLightbox) rather than via an effect, so
  // a shrunk card set — e.g. streaming cites that rehydrate to fewer cards —
  // can never index out of bounds and crash the card below.
  const safeIndex = Math.min(index, Math.max(0, count - 1));
  const go = (delta: number) =>
    setIndex((i) => (((i + delta) % count) + count) % count);

  if (count === 0) return null;

  return (
    <div className="flex flex-col gap-2.5" aria-label="Verified sources">
      <InlineSourceCard post={cards[safeIndex]} compact />
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => go(-1)}
          aria-label="Previous source"
          className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border bg-card text-foreground transition-colors hover:border-primary/40 hover:text-primary"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
        <div className="flex items-center gap-1.5" aria-hidden>
          {cards.map((card, i) => (
            <button
              key={card.id}
              type="button"
              onClick={() => setIndex(i)}
              aria-label={`Go to source ${i + 1}`}
              className={cn(
                "h-1.5 rounded-full transition-all",
                i === safeIndex
                  ? "w-4 bg-primary"
                  : "w-1.5 bg-border hover:bg-primary/40",
              )}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={() => go(1)}
          aria-label="Next source"
          className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border bg-card text-foreground transition-colors hover:border-primary/40 hover:text-primary"
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <p className="text-center text-[11px] text-muted-foreground tabular-nums">
        Source {safeIndex + 1} of {count}
      </p>
    </div>
  );
}

export function GroundedSourceLinks({ artifacts }: { artifacts?: Artifact[] }) {
  const sources = groundedSources(artifacts ?? []);
  if (sources.length === 0) return null;

  const cards = sources
    .map((s) => s.card)
    .filter((c): c is CitedPost => c !== null);
  // Sources that couldn't resolve to a full card keep a chip so nothing is lost.
  const chipOnly = sources.filter((s) => s.card === null);

  return (
    // Center the sources and cap their width to roughly a Swipe File card, so
    // the carousel reads as an editorial preview rather than a full-width block.
    // Comfortable vertical spacing above/below (my-1.5) keeps it from crowding
    // the answer text.
    <div className="my-1.5 flex w-full max-w-[360px] flex-col gap-2.5 mx-auto">
      {cards.length > 1 ? (
        <SourceCarousel cards={cards} />
      ) : cards.length === 1 ? (
        <InlineSourceCard post={cards[0]} compact />
      ) : null}
      {chipOnly.length > 0 && (
        <div className="flex flex-wrap gap-2" aria-label="Verified sources">
          {chipOnly.map((s, i) => (
            <SourceChip
              key={s.href}
              href={s.href}
              label={
                sources.length === 1
                  ? "View source post on LinkedIn"
                  : `View source ${i + 1} on LinkedIn`
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
