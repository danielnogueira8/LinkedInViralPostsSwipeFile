"use client";

import {
  Paperclip,
  Zap,
  FileText,
  Fingerprint,
  Magnet,
  Layers,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatContextSummary } from "@/lib/cowork-context-summary";

// The Cowork context card — an aggregated, read-only view of everything shaping
// the current chat: the source post it's modeling, the skills applied, the post
// format, creator style, lead-magnet giveaway, and attached files. Lives in the
// right rail so it's referenceable at a glance without scrolling the transcript
// for the chips. Every section is conditional — nothing renders when a chat has
// no context yet (the parent already gates on isContextSummaryEmpty).
export function ChatContextPanel({ summary }: { summary: ChatContextSummary }) {
  const {
    sourcePost,
    skills,
    postFormats,
    creatorStyle,
    leadMagnet,
    files,
  } = summary;

  const sourceHeading =
    sourcePost?.kind === "draft"
      ? "Refining your post"
      : sourcePost?.kind === "template"
        ? "Filling template"
        : sourcePost?.authorName
          ? `Modeling: ${sourcePost.authorName}`
          : "Modeling this post";

  return (
    <div className="flex flex-col gap-4">
      {sourcePost && (
        <Section label="Source post" icon={<Layers className="h-3.5 w-3.5" />}>
          <div className="rounded-xl border border-border/60 bg-card p-3">
            <div className="flex items-center gap-2.5">
              {sourcePost.authorAvatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={sourcePost.authorAvatar}
                  alt=""
                  className="h-8 w-8 shrink-0 rounded-lg object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-muted">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                </div>
              )}
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-[13px] font-semibold leading-tight">
                  <span className="truncate">{sourceHeading}</span>
                  {sourcePost.partial && (
                    <span className="rounded bg-state-warning-bg px-1.5 py-0.5 text-[10px] font-normal text-state-warning">
                      partial
                    </span>
                  )}
                </p>
                {sourcePost.postType === "lead_magnet" && (
                  <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Magnet className="h-2.5 w-2.5" aria-hidden />
                    Lead magnet
                  </span>
                )}
              </div>
            </div>
            <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-[12px] leading-relaxed text-foreground/80">
              {sourcePost.postText}
            </p>
          </div>
        </Section>
      )}

      {skills.length > 0 && (
        <Section label="Skills" icon={<Zap className="h-3.5 w-3.5" />}>
          <div className="flex flex-wrap gap-1.5">
            {skills.map((name) => (
              <span
                key={name}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-state-warning-border bg-state-warning-bg px-2.5 py-0.5 text-[11px] text-state-warning"
                title={`Custom skill applied: /${name}`}
              >
                <Zap className="h-3 w-3 shrink-0" aria-hidden />
                <span className="truncate">/{name}</span>
              </span>
            ))}
          </div>
        </Section>
      )}

      {creatorStyle && (
        <Section label="Creator style" icon={<Fingerprint className="h-3.5 w-3.5" />}>
          <span
            className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-state-danger-border bg-state-danger-bg px-2.5 py-0.5 text-[11px] text-primary"
            title={`Creator style: ${creatorStyle.creatorName ?? creatorStyle.name}`}
          >
            <Fingerprint className="h-3 w-3 shrink-0" aria-hidden />
            <span className="truncate">
              {creatorStyle.creatorName
                ? `Style: ${creatorStyle.creatorName}`
                : creatorStyle.name}
            </span>
          </span>
        </Section>
      )}

      {leadMagnet && (
        <Section label="Giveaway" icon={<Magnet className="h-3.5 w-3.5" />}>
          <span
            className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-state-danger-border bg-state-danger-bg px-2.5 py-0.5 text-[11px] text-primary"
            title={`Lead magnet ${leadMagnet.selection === "auto" ? "auto-selected" : "selected"}: ${leadMagnet.title}`}
          >
            <Magnet className="h-3 w-3 shrink-0" aria-hidden />
            <span className="truncate">{leadMagnet.title}</span>
          </span>
        </Section>
      )}

      {postFormats.length > 0 && (
        <Section label="Post format" icon={<FileText className="h-3.5 w-3.5" />}>
          <div className="flex flex-wrap gap-1.5">
            {postFormats.map((format) => (
              <span
                key={format}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-state-danger-border bg-state-danger-bg px-2.5 py-0.5 text-[11px] text-primary"
                title={`Post format: ${format}`}
              >
                <FileText className="h-3 w-3 shrink-0" aria-hidden />
                <span className="truncate">{format}</span>
              </span>
            ))}
          </div>
        </Section>
      )}

      {files.length > 0 && (
        <Section label="Attachments" icon={<Paperclip className="h-3.5 w-3.5" />}>
          <div className="flex flex-col gap-1.5">
            {files.map((name) => (
              <span
                key={name}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card/80 px-2.5 py-1.5 text-xs text-muted-foreground"
                title={name}
              >
                <Paperclip className="h-3 w-3 shrink-0" aria-hidden />
                <span className="truncate">{name}</span>
              </span>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function Section({
  label,
  icon,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div
        className={cn(
          "flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground",
        )}
      >
        <span className="text-muted-foreground/70">{icon}</span>
        {label}
      </div>
      {children}
    </div>
  );
}
