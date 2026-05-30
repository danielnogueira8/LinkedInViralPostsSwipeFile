import { cn } from "@/lib/utils";

// Viral-driver breakdown. Pure arithmetic — no AI, no extra data: it
// decomposes a post's engagement-weighted score into the three channels that
// produced it and names the dominant one, so a reader can tell *why* a post
// performed at a glance (broad reach vs. conversation vs. amplification).
//
// Weights mirror lib/viral.ts `score`: reactions×1, comments×3, reposts×5.
// A comment is worth 3 reactions and a repost 5 because they signal
// progressively stronger engagement — so a post with modest reactions but
// heavy reposting reads as "amplified", not "low engagement".

const W_REACTIONS = 1;
const W_COMMENTS = 3;
const W_REPOSTS = 5;

// Channel order is fixed (reactions → comments → reposts) so the stacked bar
// segments are positionally stable across cards. Tints come from the warm
// design palette; each is the channel's "identity" colour reused in legends.
const CHANNELS = [
  { key: "reactions", label: "reactions", driverLabel: "reaction-driven", tint: "bg-primary/70", weight: W_REACTIONS },
  { key: "comments", label: "comments", driverLabel: "comment-driven", tint: "bg-amber-500/70", weight: W_COMMENTS },
  { key: "reposts", label: "reposts", driverLabel: "repost-driven", tint: "bg-rose-500/70", weight: W_REPOSTS },
] as const;

export function ViralDriverBar({
  reactions,
  comments,
  reposts,
  className,
}: {
  reactions: number;
  comments: number;
  reposts: number;
  className?: string;
}) {
  const raw = { reactions, comments, reposts };
  const weighted = CHANNELS.map((c) => ({
    ...c,
    value: Math.max(0, raw[c.key] ?? 0) * c.weight,
    count: Math.max(0, raw[c.key] ?? 0),
  }));
  const total = weighted.reduce((s, c) => s + c.value, 0);

  // No engagement at all — nothing meaningful to decompose.
  if (total <= 0) return null;

  const segments = weighted.map((c) => ({
    ...c,
    share: c.value / total,
  }));
  // Dominant driver names the bar. "balanced" when no single channel clears
  // half the weighted score — a post that earned its reach across the board.
  const dominant = segments.reduce((a, b) => (b.share > a.share ? b : a));
  const driverLabel = dominant.share >= 0.5 ? dominant.driverLabel : "balanced mix";

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
        {segments.map((s) =>
          s.share > 0 ? (
            <div
              key={s.key}
              className={s.tint}
              style={{ width: `${(s.share * 100).toFixed(2)}%` }}
              title={`${s.label}: ${(s.share * 100).toFixed(0)}% of engagement weight (${s.count.toLocaleString()})`}
            />
          ) : null,
        )}
      </div>
      <div className="text-[10px] text-muted-foreground capitalize">{driverLabel}</div>
    </div>
  );
}
