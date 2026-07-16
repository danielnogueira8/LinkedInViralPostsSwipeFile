import { Coins, ExternalLink, Newspaper } from "lucide-react";

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
  const detail = usage.stages
    .map(
      (stage) =>
        `${USAGE_STAGE_LABELS[stage.kind]}: ~${stage.credits} credits · ${stage.models.map(modelDisplayName).join(", ") || "server"}`,
    )
    .join("\n");
  return (
    <div
      className="inline-flex w-fit flex-wrap items-center gap-x-2 gap-y-1 rounded-full border border-border bg-muted/35 px-2.5 py-1 text-[11px] text-muted-foreground"
      title={`${detail}\nEstimated from this task's $${usage.totalCostUsd.toFixed(4)} provider cost. Your monthly counter also accounts for its message-count floor and cumulative rounding.`}
      aria-label={`Estimated credit impact: ${usage.totalCredits} credits`}
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
    </div>
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
