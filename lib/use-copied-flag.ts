"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// A "just copied!" flag that flips true on markCopied() and auto-resets after a
// delay. Replaces the copy-pasted `setCopied(true); setTimeout(() =>
// setCopied(false), 1500)` in copy buttons, which had two bugs:
//   • no cleanup on unmount → a setState-on-unmounted-component warning if the
//     component (a chat message, a draft card) unmounted within the window,
//   • no timer dedup → rapid clicks stacked timers, so "Copied" lingered longer
//     than intended.
// This tracks a single timer in a ref: each markCopied() clears the prior one,
// and an unmount clears whatever's pending.
export function useCopiedFlag(resetMs = 1500): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const markCopied = useCallback(() => {
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setCopied(false);
      timerRef.current = null;
    }, resetMs);
  }, [resetMs]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return [copied, markCopied];
}
