"use client";

import { useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  ShieldCheck,
} from "lucide-react";
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
type ResolvedSource = { href: string | null; card: CitedPost | null };

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
    const renderableCard =
      matches && isRenderableCard(card) ? card : null;
    if (!href && !renderableCard) continue;
    const identity = `post:${String(postId)}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    // Only render a full card when the rehydrated post matches this cite's id
    // AND is a complete CitedPost; else fall back to the chip.
    out.push({
      href: href ?? null,
      card: renderableCard,
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

const SOURCES_PER_PAGE = 3;

// Three-at-a-time carousel of source cards that wraps (last page → first).
// Prev/next retain the existing controls while each step advances one page.
function SourceCarousel({ cards }: { cards: CitedPost[] }) {
  const [page, setPage] = useState(0);
  const count = cards.length;
  const pageCount = Math.ceil(count / SOURCES_PER_PAGE);
  // Clamp at render time (like DocumentLightbox) rather than via an effect, so
  // a shrunk card set — e.g. streaming cites that rehydrate to fewer cards —
  // can never index out of bounds and crash the cards below.
  const safePage = Math.min(page, Math.max(0, pageCount - 1));
  const firstVisible = safePage * SOURCES_PER_PAGE;
  const visibleCards = cards.slice(
    firstVisible,
    firstVisible + SOURCES_PER_PAGE,
  );
  const lastVisible = firstVisible + visibleCards.length;
  const go = (delta: number) =>
    setPage((current) =>
      (((current + delta) % pageCount) + pageCount) % pageCount
    );

  if (count === 0) return null;

  return (
    <div className="flex flex-col gap-2.5" aria-label="Verified sources">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {visibleCards.map((card) => (
          <InlineSourceCard
            key={card.id}
            post={card}
            compact
            mediaLoading="eager"
          />
        ))}
      </div>
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
          {Array.from({ length: pageCount }, (_, pageIndex) => (
            <button
              key={`source-page-${pageIndex}`}
              type="button"
              onClick={() => setPage(pageIndex)}
              aria-label={`Go to source group ${pageIndex + 1}`}
              className={cn(
                "h-1.5 rounded-full transition-all",
                pageIndex === safePage
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
        Sources {firstVisible + 1}–{lastVisible} of {count}
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
  const chipOnly = sources.filter(
    (source): source is { href: string; card: null } =>
      source.card === null && source.href !== null,
  );

  return (
    // Use the same width cap as the conversation so three compact source cards
    // fit without turning the carousel into a full-bleed surface.
    <div
      className={cn(
        "my-1.5 mx-auto flex w-full flex-col gap-2.5",
        cards.length > 1 ? "max-w-4xl" : "max-w-[360px]",
      )}
    >
      <div className="flex items-center gap-2 px-0.5">
        <ShieldCheck
          className="size-3.5 text-state-success"
          aria-hidden="true"
        />
        <span className="text-xs font-semibold text-foreground">
          Verified {sources.length === 1 ? "source" : "sources"}
        </span>
        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-border bg-muted px-1.5 text-[10px] font-semibold tabular-nums text-muted-foreground">
          {sources.length}
        </span>
      </div>
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
