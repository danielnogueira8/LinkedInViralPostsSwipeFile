"use client";

import { hookCutoff, HOOK_LIMITS, type HookViewport } from "@/lib/hook-cutoff";
import { cn } from "@/lib/utils";

// Shows where LinkedIn hides the rest of a post behind "…see more".
//
// This lives on POST PREVIEWS, not inside the editor. The cut depends on
// rendered line width, so in a resizable editor the model can't know where the
// line actually falls — and a rule floating over live text reads as noise. On a
// fixed-width preview the position is meaningful and the layout is stable.

/**
 * Renders the body the way the feed does: the visible snippet, then the real
 * "…see more" affordance, then the remainder dimmed so the writer can still
 * read it.
 */
export function HookCutoffPreview({
  body,
  viewport = "mobile",
  className,
}: {
  body: string;
  viewport?: HookViewport;
  className?: string;
}) {
  const { visible, hidden, reason } = hookCutoff(body, viewport);

  if (reason === "none") {
    return (
      <div className={cn("whitespace-pre-wrap text-foreground", className)}>
        {body}
      </div>
    );
  }

  return (
    <div className={cn("text-foreground", className)}>
      {/* The snippet, ending exactly where the feed ends it — mid-sentence,
          with the ellipsis and link inline, as LinkedIn renders it. */}
      <span className="whitespace-pre-wrap">{visible}</span>
      <span className="text-muted-foreground">… </span>
      <span className="font-medium text-muted-foreground">see more</span>

      {/* Everything past the fold, dimmed rather than hidden: the writer still
          needs to read their own post. */}
      <div className="mt-1 whitespace-pre-wrap text-muted-foreground/60">
        {hidden.replace(/^\s+/, "")}
      </div>
    </div>
  );
}

/**
 * A one-line summary of the cut for a status bar: how much of the hook is
 * visible, and what happens past it. Null when nothing is truncated.
 */
export function HookCutoffSummary({
  body,
  viewport = "mobile",
  className,
}: {
  body: string;
  viewport?: HookViewport;
  className?: string;
}) {
  const { visible, reason } = hookCutoff(body, viewport);
  const { label, chars } = HOOK_LIMITS[viewport];
  if (reason === "none") return null;
  return (
    <span className={cn("text-muted-foreground", className)}>
      {label}: ~{visible.length} of {chars} chars shown before “…see more”
      {reason === "breaks" ? " — line breaks shorten it" : ""}
    </span>
  );
}
