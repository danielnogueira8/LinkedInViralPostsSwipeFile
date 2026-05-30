import Link from "next/link";
import { BarChart3, Flame } from "lucide-react";
import { fetchHookPatternLeaderboard } from "@/lib/insights-query";
import { Card, CardContent } from "@/components/ui/card";

// Insights — aggregate analytics over the workspace's tracked viral posts.
// Every number here is pure SQL-fetch + in-JS reduction (no AI). Sections are
// added incrementally; B1 (hook-pattern leaderboard) ships first.

export const dynamic = "force-dynamic";

// Human labels for hook pattern_tags. Mirrors the set in the Hook Library; an
// unknown tag (older classifier output) falls back to a title-cased version.
const PATTERN_LABELS: Record<string, string> = {
  contrarian: "Contrarian",
  personal_failure: "Personal failure",
  numbered_promise: "Numbered promise",
  curiosity_gap: "Curiosity gap",
  authority_drop: "Authority drop",
  stat_shock: "Stat shock",
  question: "Question",
  confession: "Confession",
  story_setup: "Story setup",
  direct_callout: "Direct callout",
};

function labelFor(tag: string): string {
  return PATTERN_LABELS[tag] ?? tag.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default async function InsightsPage() {
  const hookPatterns = await fetchHookPatternLeaderboard();

  // The widest bar = the highest hit-rate, so bars are comparable at a glance.
  const maxHitRate = hookPatterns.reduce((m, r) => Math.max(m, r.hitRate), 0) || 1;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-4xl font-display tracking-tight">Insights</h1>
        <p className="text-sm text-muted-foreground mt-1">
          What actually correlates with virality across the creators you track.
        </p>
      </div>

      {/* B1 — Hook-pattern leaderboard */}
      <section className="rounded-xl border border-border/60 bg-card shadow-soft overflow-hidden">
        <div className="px-4 sm:px-5 py-3 border-b border-border/60 bg-background/40 flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold tracking-tight">Hook patterns by hit-rate</h2>
          <span className="text-xs text-muted-foreground ml-auto hidden sm:block">
            share of posts using each opening that went viral
          </span>
        </div>

        {hookPatterns.length > 0 ? (
          <div className="divide-y divide-border/50">
            {hookPatterns.map((r) => (
              <Link
                key={r.pattern}
                href={`/dashboard/hooks?pattern=${encodeURIComponent(r.pattern)}`}
                className="flex items-center gap-3 px-4 sm:px-5 py-3 hover:bg-muted/40 transition-colors"
                title={`${r.viralPosts} of ${r.posts} posts with a ${labelFor(r.pattern)} hook went viral`}
              >
                <div className="w-32 sm:w-40 shrink-0 text-sm font-medium truncate">
                  {labelFor(r.pattern)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-primary/70"
                      style={{ width: `${((r.hitRate / maxHitRate) * 100).toFixed(1)}%` }}
                    />
                  </div>
                </div>
                <div className="w-14 shrink-0 text-right text-sm font-semibold tabular-nums">
                  {Math.round(r.hitRate * 100)}%
                </div>
                <div className="w-24 shrink-0 text-right text-xs text-muted-foreground tabular-nums hidden sm:block">
                  {r.viralPosts}/{r.posts} · med {Math.round(r.medianViralScore).toLocaleString()}
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <EmptyState />
        )}
      </section>
    </div>
  );
}

function EmptyState() {
  return (
    <Card className="border-0 shadow-none rounded-none bg-transparent">
      <CardContent className="py-12 px-6 text-center space-y-3 max-w-md mx-auto">
        <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-orange-500/15 to-primary/10 grid place-items-center mx-auto ring-1 ring-orange-500/10">
          <Flame className="h-5 w-5 text-orange-500" />
        </div>
        <div className="text-sm text-muted-foreground leading-relaxed">
          No hook data yet. Patterns are tagged automatically on each daily
          scrape — run one from the{" "}
          <Link href="/dashboard/accounts" className="underline">
            Accounts
          </Link>{" "}
          page or wait for the next pull.
        </div>
      </CardContent>
    </Card>
  );
}
