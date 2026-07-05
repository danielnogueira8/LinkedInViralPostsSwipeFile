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
  alt = "",
  className,
  fallback,
}: {
  src: string | null | undefined;
  alt?: string;
  className?: string;
  // Rendered when src is absent OR fails to load. Caller styles it to match
  // (same size/shape as the img).
  fallback: ReactNode;
}) {
  // Track WHICH src failed, not just a boolean — so when the src changes (e.g.
  // regenerating the voice replaces an expired LinkedIn url with a fresh one),
  // the new url gets a fresh chance to load instead of staying stuck on the old
  // url's failure. Without this, a previously-broken avatar wouldn't reappear
  // until a full page reload reset the state.
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  if (!src || brokenSrc === src) return <>{fallback}</>;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      onError={() => setBrokenSrc(src)}
      className={className}
    />
  );
}
