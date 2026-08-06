"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { StatusPill } from "@/components/app-surface";
import { Quote, Telescope, PenLine, LayoutList, ArrowRight } from "lucide-react";
import {
  cleanInline,
  extractHookQuote,
  formatDigestDate,
  hookCommentary,
  parseDigest,
  relativeDigestLabel,
  splitAngles,
  type DigestSectionId,
} from "@/lib/digest-view-model";

export type DigestRow = {
  digestDate: string;
  content: string;
  postCount: number;
};

const SECTION_ICON: Record<DigestSectionId, typeof Quote> = {
  theme: Telescope,
  hook: Quote,
  format: LayoutList,
  write_next: PenLine,
};

/**
 * Render a body as paragraphs.
 *
 * No markdown dependency: the digest's structure is known, so the page parses
 * it into real sections rather than rendering a generic blob. Inline `**` and
 * raw post UUIDs are stripped — the ids are not actionable for a reader, and
 * the asterisks would show literally.
 */
function Prose({ body }: { body: string }) {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => cleanInline(p.replace(/\n/g, " ")))
    .filter(Boolean);
  return (
    <div className="space-y-3">
      {paragraphs.map((paragraph, i) => (
        <p key={i} className="text-sm leading-6 text-muted-foreground">
          {paragraph}
        </p>
      ))}
    </div>
  );
}

function SectionCard({
  id,
  title,
  children,
}: {
  id: DigestSectionId;
  title: string;
  children: React.ReactNode;
}) {
  const Icon = SECTION_ICON[id];
  return (
    <section className="rounded-xl border border-border bg-card/60 p-5">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="size-4 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function DigestBody({ digest }: { digest: DigestRow }) {
  const { sections, unmatched } = parseDigest(digest.content);

  // The model drifted from the four-section format. Show the raw text rather
  // than a blank page — losing model output silently is how you end up
  // debugging a "broken" digest that was actually fine.
  if (sections.length === 0) {
    return (
      <Card className="border-border/70 bg-card/90">
        <CardContent className="p-5">
          <p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
            {digest.content}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {sections.map((section) => {
        if (section.id === "hook") {
          const quote = extractHookQuote(section.body);
          const rest = quote ? hookCommentary(section.body) : null;
          return (
            <SectionCard key={section.id} id={section.id} title={section.title}>
              {quote ? (
                <>
                  {/* The one line worth reading twice gets pull-quote weight. */}
                  <blockquote className="border-l-2 border-primary/40 pl-4 text-lg font-medium leading-7 text-foreground">
                    {quote}
                  </blockquote>
                  {rest ? (
                    <p className="mt-3 text-sm leading-6 text-muted-foreground">
                      {rest}
                    </p>
                  ) : null}
                </>
              ) : (
                <Prose body={section.body} />
              )}
            </SectionCard>
          );
        }

        if (section.id === "write_next") {
          const angles = splitAngles(section.body);
          return (
            <SectionCard key={section.id} id={section.id} title={section.title}>
              <div className="grid gap-3 sm:grid-cols-2">
                {angles.map((angle, i) => (
                  <div
                    key={i}
                    className="rounded-lg border border-border bg-background/60 p-4"
                  >
                    <p className="text-sm leading-6 text-foreground">
                      {cleanInline(angle.replace(/\n/g, " "))}
                    </p>
                  </div>
                ))}
              </div>
              {/* The digest's only job is to make tomorrow's post easier, so
                  the page ends on the action rather than on more prose. */}
              <Link
                href="/dashboard"
                className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
              >
                Draft one of these <ArrowRight className="size-4" />
              </Link>
            </SectionCard>
          );
        }

        return (
          <SectionCard key={section.id} id={section.id} title={section.title}>
            <Prose body={section.body} />
          </SectionCard>
        );
      })}

      {unmatched ? (
        <SectionCard id="theme" title="Also noted">
          <Prose body={unmatched} />
        </SectionCard>
      ) : null}
    </div>
  );
}

export function DigestView({
  digests,
  todayIso,
}: {
  digests: DigestRow[];
  todayIso: string;
}) {
  const [activeDate, setActiveDate] = useState(digests[0]?.digestDate ?? "");
  const active =
    digests.find((digest) => digest.digestDate === activeDate) ?? digests[0];
  const today = new Date(`${todayIso}T00:00:00Z`);

  if (!active) return null;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_200px] lg:items-start">
      <div className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold tracking-tight">
            {formatDigestDate(active.digestDate)}
          </h1>
          <StatusPill tone="neutral" className="h-6">
            {active.postCount} posts
          </StatusPill>
        </div>
        <DigestBody digest={active} />
      </div>

      {/* History rail. Only shown once there is history — a single-item list
          is chrome without information. */}
      {digests.length > 1 ? (
        <nav
          aria-label="Earlier digests"
          className="order-first lg:order-none lg:sticky lg:top-4"
        >
          <div className="mb-2 px-1 text-xs font-medium text-muted-foreground">
            Earlier
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
            {digests.map((digest) => {
              const isActive = digest.digestDate === active.digestDate;
              return (
                <button
                  key={digest.digestDate}
                  type="button"
                  onClick={() => setActiveDate(digest.digestDate)}
                  aria-current={isActive ? "true" : undefined}
                  className={`shrink-0 rounded-lg border px-3 py-2 text-left text-xs transition-colors lg:w-full ${
                    isActive
                      ? "border-primary/30 bg-primary/[0.06] text-foreground"
                      : "border-border text-muted-foreground hover:bg-muted"
                  }`}
                >
                  <div className="font-medium">
                    {relativeDigestLabel(digest.digestDate, today)}
                  </div>
                  <div className="mt-0.5 opacity-70">
                    {digest.postCount} posts
                  </div>
                </button>
              );
            })}
          </div>
        </nav>
      ) : null}
    </div>
  );
}
