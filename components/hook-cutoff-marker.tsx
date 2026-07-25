"use client";

import { hookCutoff, HOOK_LIMITS, type HookViewport } from "@/lib/hook-cutoff";
import { cn } from "@/lib/utils";

// A soft dotted rule showing where LinkedIn hides the rest of a post behind
// "…see more", drawn over a draft's text.
//
// Deliberately quiet: dotted, muted, and it disappears entirely when the post
// is short enough not to be cut. It's a writing aid, not a warning — nothing
// here is an error state.

export function HookCutoffMarker({
  viewport = "mobile",
  className,
}: {
  viewport?: HookViewport;
  className?: string;
}) {
  const { lines, chars, label } = HOOK_LIMITS[viewport];
  return (
    <div
      className={cn("pointer-events-none flex items-center gap-2", className)}
      aria-hidden
    >
      <span className="h-px flex-1 border-t border-dashed border-border" />
      <span className="whitespace-nowrap text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {label} · “…see more”
      </span>
      <span className="h-px flex-1 border-t border-dashed border-border" />
      <span className="sr-only">
        {`LinkedIn hides the rest of this post behind "see more" on ${label.toLowerCase()} — about ${chars} characters or ${lines} lines.`}
      </span>
    </div>
  );
}

/**
 * The read-only preview: renders the body with the cutoff rule drawn in place
 * and everything past it dimmed, so the hook is visible at a glance.
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
  return (
    <div className={cn("whitespace-pre-wrap text-[13px] leading-relaxed", className)}>
      <span className="text-foreground">{visible}</span>
      {reason !== "none" && (
        <>
          <HookCutoffMarker viewport={viewport} className="my-2" />
          {/* Dimmed, not hidden — the writer still needs to read the rest. */}
          <span className="text-muted-foreground/70">{hidden}</span>
        </>
      )}
    </div>
  );
}
