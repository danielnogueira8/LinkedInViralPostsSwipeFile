import { ChevronDown, Coins, ExternalLink, Newspaper } from "lucide-react";

import type { CoworkTurnUsage, ResearchSource } from "@/lib/cowork-turn-usage";

const USAGE_STAGE_LABELS: Record<
  CoworkTurnUsage["stages"][number]["kind"],
  string
> = {
  planning: "Planning",
  research: "Research",
  writing: "Writing",
  other: "Other",
};

function modelDisplayName(model: string): string {
  if (/luna/i.test(model)) return "Luna";
  if (/haiku/i.test(model)) return "Haiku";
  if (/sonnet/i.test(model)) return "Sonnet";
  if (/gemini/i.test(model)) return "Gemini";
  if (/glm/i.test(model)) return "GLM";
  return model.split("/").pop() ?? model;
}

export function TaskUsageSummary({ usage }: { usage: CoworkTurnUsage }) {
  // Native <details> disclosure: the credit breakdown used to live in a
  // title tooltip — invisible to keyboard, touch, and screen readers.
  return (
    <details className="group w-fit">
      <summary
        className="inline-flex w-fit cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 rounded-full border border-border bg-muted/35 px-2.5 py-1 text-[11px] text-muted-foreground [&::-webkit-details-marker]:hidden"
        aria-label={`Estimated credit impact: ${usage.totalCredits} credits. Activate for the breakdown.`}
      >
        <Coins className="h-3 w-3" aria-hidden />
        <span className="font-medium text-foreground">
          ~{usage.totalCredits} {usage.totalCredits === 1 ? "credit" : "credits"}
        </span>
        {usage.stages.map((stage) => (
          <span key={stage.kind}>
            {USAGE_STAGE_LABELS[stage.kind]} ~{stage.credits}
          </span>
        ))}
        <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="mt-1.5 max-w-xs rounded-lg border border-border bg-card p-2.5 text-[11px] leading-5 text-muted-foreground shadow-soft">
        {usage.stages.map((stage) => (
          <div key={stage.kind}>
            {USAGE_STAGE_LABELS[stage.kind]}: ~{stage.credits} credits ·{" "}
            {stage.models.map(modelDisplayName).join(", ") || "server"}
          </div>
        ))}
        <div className="mt-1.5 border-t border-border pt-1.5">
          Estimated from this task&apos;s ${usage.totalCostUsd.toFixed(4)} provider
          cost. Your monthly counter also accounts for its message-count floor
          and cumulative rounding.
        </div>
      </div>
    </details>
  );
}

export function ResearchSources({ sources }: { sources: ResearchSource[] }) {
  if (sources.length === 0) return null;
  return (
    <section className="border-t border-border/70 bg-muted/20 px-4 py-3">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
        <Newspaper className="h-3.5 w-3.5 text-primary" aria-hidden />
        Sources used
        <span className="font-normal text-muted-foreground">
          · {sources.length} verified
        </span>
      </div>
      <div className="space-y-1.5">
        {sources.map((source) => (
          <a
            key={source.url}
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground transition-colors hover:text-primary"
          >
            <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="font-medium text-foreground">
                {source.title}
              </span>
              {source.publishedAt ? ` · ${source.publishedAt}` : ""}
            </span>
          </a>
        ))}
      </div>
    </section>
  );
}
