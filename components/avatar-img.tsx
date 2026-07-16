"use client";

import { useState, type ReactNode } from "react";

// An <img> avatar that falls back to a placeholder when the source fails to
// load. LinkedIn CDN avatar URLs (stored on voice_profiles.avatar_url and on
// scraped post authors) are TIME-LIMITED — they expire after days/weeks. Without
// an onError handler a stale URL renders the browser's broken-image icon (a gray
// placeholder) instead of degrading gracefully. This component swaps to the
// caller-supplied `fallback` (initials, an icon, …) on the first load error, and
// also when there's no src to begin with.
//
// Kept tiny and dependency-free; it's just the onError state the voice card
// already had, made reusable so every avatar surface gets the same safety.
export function AvatarImg({
  src,
  fallbackSrc,
  alt = "",
  className,
  fallback,
}: {
  src: string | null | undefined;
  // A SECOND image URL to try when `src` fails to load, BEFORE showing the
  // `fallback` node. Use it for a more-stable backup: e.g. the user's own
  // profile pic is a LinkedIn CDN URL (expires) with the Clerk-hosted photo as a
  // durable backup — an expired LinkedIn URL then degrades to the Clerk photo,
  // not straight to initials. Ignored when equal to `src` or absent.
  fallbackSrc?: string | null | undefined;
  alt?: string;
  className?: string;
  // Rendered when there's no usable src OR every candidate fails to load. Caller
  // styles it to match (same size/shape as the img).
  fallback: ReactNode;
}) {
  // Ordered, de-duplicated list of image URLs to try. `broken` advances through
  // it on each load error; when we run past the end, we render `fallback`.
  const candidates = [src, fallbackSrc].filter(
    (u, i, arr): u is string => !!u && arr.indexOf(u) === i,
  );
  const [failedCount, setFailedCount] = useState(0);
  const current = candidates[failedCount];
  if (!current) return <>{fallback}</>;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      // key: force a fresh <img> when we advance to the next candidate so the
      // browser actually re-requests instead of reusing the errored element.
      key={current}
      src={current}
      alt={alt}
      onError={() => setFailedCount((n) => n + 1)}
      className={className}
    />
  );
}
