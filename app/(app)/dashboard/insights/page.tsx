import Link from "next/link";
import { BarChart3, Flame, LayoutGrid, Clock, Trophy } from "lucide-react";
import {
  fetchHookPatternLeaderboard,
  fetchPostTypeBoard,
  fetchTimeHeatmap,
  fetchNicheScoreboard,
  HEATMAP_TZ_LABEL,
  type TimeHeatmap,
} from "@/lib/insights-query";
import { Card, CardContent } from "@/components/ui/card";

// Insights — aggregate analytics over the workspace's tracked viral posts.
// Every number here is pure SQL-fetch + in-JS reduction (no AI). Sections are
// added incrementally; B1 (hook-pattern leaderboard) ships first.

export const dynamic = "force-dynamic";

// Human labels for hook pattern_tags. Mirrors the set in the Hook Library; an
// unknown tag (older classifier output) falls back to a title-cased version.
const POST_TYPE_LABELS: Record<string, string> = {
  regular: "Regular posts",
  lead_magnet: "Lead magnets",
};

function postTypeLabel(t: string): string {
  return POST_TYPE_LABELS[t] ?? t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

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
  const [hookPatterns, postTypes, heatmap, niches] = await Promise.all([
    fetchHookPatternLeaderboard(),
    fetchPostTypeBoard(),
    fetchTimeHeatmap(),
    fetchNicheScoreboard(),
  ]);

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

      {/* B2 — Post-type performance board */}
      <section className="rounded-xl border border-border/60 bg-card shadow-soft overflow-hidden">
        <div className="px-4 sm:px-5 py-3 border-b border-border/60 bg-background/40 flex items-center gap-2">
          <LayoutGrid className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold tracking-tight">Performance by post type</h2>
          <span className="text-xs text-muted-foreground ml-auto hidden sm:block">
            volume and viral hit-rate per type
          </span>
        </div>

        {postTypes.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-px bg-border/50">
            {postTypes.map((r) => (
              <div key={r.postType} className="bg-card px-4 sm:px-5 py-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-medium">{postTypeLabel(r.postType)}</div>
                  <div className="text-xs text-muted-foreground tabular-nums">
                    {r.posts.toLocaleString()} post{r.posts === 1 ? "" : "s"}
                  </div>
                </div>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="text-2xl font-display tabular-nums">{Math.round(r.hitRate * 100)}%</span>
                  <span className="text-xs text-muted-foreground">went viral</span>
                </div>
                <div className="mt-1 text-xs text-muted-foreground tabular-nums">
                  {r.viralPosts.toLocaleString()} viral · median score{" "}
                  {Math.round(r.medianViralScore).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState />
        )}
      </section>

      {/* B3 — Best-time-to-post heatmap */}
      <section className="rounded-xl border border-border/60 bg-card shadow-soft overflow-hidden">
        <div className="px-4 sm:px-5 py-3 border-b border-border/60 bg-background/40 flex items-center gap-2">
          <Clock className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold tracking-tight">When big posts land</h2>
          <span className="text-xs text-muted-foreground ml-auto hidden sm:block">
            median engagement by day × hour ({HEATMAP_TZ_LABEL})
          </span>
        </div>
        {heatmap.totalPosts > 0 ? (
          <div className="px-4 sm:px-5 py-4 overflow-x-auto">
            <TimeHeatmapGrid heatmap={heatmap} />
          </div>
        ) : (
          <EmptyState />
        )}
      </section>

      {/* B4 — Niche scoreboard */}
      <section className="rounded-xl border border-border/60 bg-card shadow-soft overflow-hidden">
        <div className="px-4 sm:px-5 py-3 border-b border-border/60 bg-background/40 flex items-center gap-2">
          <Trophy className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold tracking-tight">Niche scoreboard</h2>
          <span className="text-xs text-muted-foreground ml-auto hidden sm:block">
            which spaces produce the strongest posts
          </span>
        </div>
        {niches.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground border-b border-border/50">
                  <th className="text-left font-medium px-4 sm:px-5 py-2">Niche</th>
                  <th className="text-right font-medium px-3 py-2 tabular-nums">Creators</th>
                  <th className="text-right font-medium px-3 py-2 tabular-nums">Posts</th>
                  <th className="text-right font-medium px-3 py-2 tabular-nums">Viral %</th>
                  <th className="text-right font-medium px-4 sm:px-5 py-2 tabular-nums">Median score</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {niches.map((r) => (
                  <tr key={r.niche} className="hover:bg-muted/40 transition-colors">
                    <td className="px-4 sm:px-5 py-2.5 font-medium truncate max-w-[14rem]">{r.niche}</td>
                    <td className="px-3 py-2.5 text-right text-muted-foreground tabular-nums">{r.creators.toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right text-muted-foreground tabular-nums">{r.posts.toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-semibold">{Math.round(r.hitRate * 100)}%</td>
                    <td className="px-4 sm:px-5 py-2.5 text-right tabular-nums">{Math.round(r.medianViralScore).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState />
        )}
      </section>
    </div>
  );
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function TimeHeatmapGrid({ heatmap }: { heatmap: TimeHeatmap }) {
  // Index cells by day:hour for O(1) lookup while rendering the full grid.
  const byKey = new Map(heatmap.cells.map((c) => [`${c.day}:${c.hour}`, c]));
  const max = heatmap.maxMedian || 1;
  const hours = Array.from({ length: 24 }, (_, h) => h);
  // Compact axis ticks: midnight, 6, noon, 18.
  const tickHours = new Set([0, 6, 12, 18]);

  return (
    <div className="min-w-[640px] text-[10px] text-muted-foreground">
      {/* Hour axis */}
      <div className="flex pl-9">
        {hours.map((h) => (
          <div key={h} className="flex-1 text-center tabular-nums">
            {tickHours.has(h) ? (h === 0 ? "12a" : h === 12 ? "12p" : h < 12 ? `${h}a` : `${h - 12}p`) : ""}
          </div>
        ))}
      </div>
      {DAY_LABELS.map((label, day) => (
        <div key={day} className="flex items-center">
          <div className="w-9 shrink-0 pr-1 text-right font-medium">{label}</div>
          {hours.map((hour) => {
            const cell = byKey.get(`${day}:${hour}`);
            const intensity = cell ? cell.medianViralScore / max : 0;
            return (
              <div
                key={hour}
                className="flex-1 aspect-square m-px rounded-[2px]"
                style={{
                  backgroundColor: cell
                    ? `color-mix(in oklab, var(--primary) ${Math.round(12 + intensity * 88)}%, transparent)`
                    : "var(--muted)",
                }}
                title={
                  cell
                    ? `${label} ${formatHour(hour)} (${HEATMAP_TZ_LABEL}) — ${cell.posts} post${cell.posts === 1 ? "" : "s"}, median score ${Math.round(cell.medianViralScore).toLocaleString()}, ${cell.viralPosts} viral`
                    : `${label} ${formatHour(hour)} (${HEATMAP_TZ_LABEL}) — no posts`
                }
              />
            );
          })}
        </div>
      ))}
      <div className="mt-2 flex items-center gap-2 pl-9">
        <span>Lower</span>
        <div className="flex gap-px">
          {[0.15, 0.4, 0.65, 0.9].map((t) => (
            <div
              key={t}
              className="h-2.5 w-4 rounded-[2px]"
              style={{ backgroundColor: `color-mix(in oklab, var(--primary) ${Math.round(t * 100)}%, transparent)` }}
            />
          ))}
        </div>
        <span>Higher median engagement</span>
      </div>
    </div>
  );
}

function formatHour(h: number): string {
  if (h === 0) return "12am";
  if (h === 12) return "12pm";
  return h < 12 ? `${h}am` : `${h - 12}pm`;
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
