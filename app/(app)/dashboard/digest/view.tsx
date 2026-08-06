"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { StatusPill } from "@/components/app-surface";
import { Quote, Telescope, LayoutList, Newspaper } from "lucide-react";
import { PostCard } from "@/components/post-card";
import type { PostCardRow } from "@/lib/post-card-row";
import {
  cleanInline,
  extractHookQuote,
  formatDigestDate,
  hookCommentary,
  parseDigest,
  referencedPostIds,
  splitEvidence,
  splitSectionLead,
  relativeDigestLabel,
  type DigestSectionId,
} from "@/lib/digest-view-model";

export type DigestRow = {
  digestDate: string;
  content: string;
  postCount: number;
};

// write_next is intentionally absent: the section is no longer displayed.
// parseDigest still RECOGNISES the heading, so its text terminates the FORMAT
// section rather than being appended to it.
const SECTION_ICON: Partial<Record<DigestSectionId, typeof Quote>> = {
  theme: Telescope,
  hook: Quote,
  format: LayoutList,
};

const DISPLAYED_SECTIONS: DigestSectionId[] = ["theme", "hook", "format"];

/**
 * Render a body as paragraphs.
 *
 * No markdown dependency: the digest's structure is known, so the page parses
 * it into real sections rather than rendering a generic blob. Inline `**` and
 * raw post UUIDs are stripped — the ids are not actionable for a reader, and
 * the asterisks would show literally.
 */
/**
 * A section: the claim in readable type, its evidence as scannable rows.
 *
 * Everything used to render as ONE dense paragraph — the theme section is 429
 * characters — so the claim and its supporting numbers had identical weight and
 * you had to read the whole thing to find the point. The model already marks
 * the claim in bold; this uses that instead of stripping it.
 *
 * Falls back to plain prose when the model marked no claim or the evidence is
 * genuinely one continuous thought, so a reformat never invents structure that
 * is not there.
 */
function SectionContent({ body }: { body: string }) {
  const { claim, evidence } = splitSectionLead(body);
  const items = splitEvidence(evidence);

  if (!claim && items.length === 0) return <Prose body={body} />;

  return (
    <div className="space-y-3">
      {claim ? (
        <p className="text-[15px] font-medium leading-6 text-foreground">
          {claim}
        </p>
      ) : null}

      {items.length > 0 ? (
        <ul className="space-y-1.5">
          {items.map((item, i) => (
            <li
              key={i}
              className="flex flex-wrap items-baseline gap-x-2 text-sm leading-6"
            >
              <span
                aria-hidden
                className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground/40"
              />
              {item.title ? (
                <span className="font-medium text-foreground">{item.title}</span>
              ) : null}
              <span className="text-muted-foreground">{item.detail}</span>
            </li>
          ))}
        </ul>
      ) : evidence ? (
        <p className="text-sm leading-6 text-muted-foreground">{evidence}</p>
      ) : null}
    </div>
  );
}

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
  const Icon = SECTION_ICON[id] ?? LayoutList;
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

function DigestBody({
  digest,
  referencedPosts,
}: {
  digest: DigestRow;
  referencedPosts: PostCardRow[];
}) {
  const { sections, unmatched } = parseDigest(digest.content);
  // Ordered by first mention, so the post the brief leads with leads here too.
  const citedOrder = referencedPostIds(digest.content);
  const byId = new Map(referencedPosts.map((post) => [post.id, post]));
  const cited = citedOrder
    .map((id) => byId.get(id))
    .filter((post): post is PostCardRow => Boolean(post));

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
      {sections
        .filter((section) => DISPLAYED_SECTIONS.includes(section.id))
        .map((section) => {
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

        return (
          <SectionCard key={section.id} id={section.id} title={section.title}>
            <SectionContent body={section.body} />
          </SectionCard>
        );
      })}

      {unmatched ? (
        <SectionCard id="theme" title="Also noted">
          <Prose body={unmatched} />
        </SectionCard>
      ) : null}

      {/* The posts the brief actually cites. The ids were already in the
          stored content, so this is evidence the reader can check rather than
          taking the model's word for it — and it is the same card as the Swipe
          File, so Save/Model actions come along unchanged. */}
      {cited.length > 0 ? (
        <section className="rounded-xl border border-border bg-card/60 p-5">
          <div className="mb-1 flex items-center gap-2">
            <Newspaper className="size-4 text-muted-foreground" aria-hidden />
            <h2 className="text-sm font-semibold tracking-tight">
              Posts behind this brief
            </h2>
          </div>
          <p className="mb-4 text-xs text-muted-foreground">
            {cited.length === 1
              ? "The post the brief cites."
              : `The ${cited.length} posts the brief cites.`}
          </p>
          {/* Three across at desktop width. The cards now get the full page
              width (the history rail moved out of the content column), so two
              columns left them wider than a post needs to be readable. */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {cited.map((post) => (
              <PostCard key={post.id} post={post} clients={[]} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

export function DigestView({
  digests,
  todayIso,
  referencedPosts,
}: {
  digests: DigestRow[];
  todayIso: string;
  referencedPosts: PostCardRow[];
}) {
  const [activeDate, setActiveDate] = useState(digests[0]?.digestDate ?? "");
  const active =
    digests.find((digest) => digest.digestDate === activeDate) ?? digests[0];
  const today = new Date(`${todayIso}T00:00:00Z`);

  if (!active) return null;

  return (
    // Single column. The rail used to be a 200px grid track beside the
    // content, which narrowed every section card to less than the page header
    // above it — the cards read as inset from the page rather than part of it.
    // As a horizontal strip the rail costs one row of height and lets the cards
    // span the full width, matching the header.
    <div className="space-y-4">
      {/* History. Only shown once there IS history — a one-item list is chrome
          without information. */}
      {digests.length > 1 ? (
        <nav aria-label="Earlier digests">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {digests.map((digest) => {
              const isActive = digest.digestDate === active.digestDate;
              return (
                <button
                  key={digest.digestDate}
                  type="button"
                  onClick={() => setActiveDate(digest.digestDate)}
                  aria-current={isActive ? "true" : undefined}
                  className={`shrink-0 rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
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

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="text-xl font-semibold tracking-tight">
          {formatDigestDate(active.digestDate)}
        </h1>
        <StatusPill tone="neutral" className="h-6">
          {active.postCount} posts
        </StatusPill>
      </div>
      <DigestBody digest={active} referencedPosts={referencedPosts} />
    </div>
  );
}
