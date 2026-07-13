"use client";

import { useState } from "react";

export function PublicLeadMagnetAvatar({
  name,
  avatarUrl,
}: {
  name: string | null;
  avatarUrl: string | null;
}) {
  const [broken, setBroken] = useState(false);
  const displayName = name?.trim() || "Creator";
  const initials = displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return (
    <div className="shrink-0">
      {avatarUrl && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element -- LinkedIn profile photos are external and may expire; this component handles fallback.
        <img
          src={avatarUrl}
          alt={displayName}
          onError={() => setBroken(true)}
          className="h-11 w-11 rounded-full border border-border/70 object-cover"
          loading="lazy"
        />
      ) : (
        <div
          aria-label={displayName}
          className="grid h-11 w-11 place-items-center rounded-full border border-border/70 bg-muted text-sm font-semibold text-foreground"
        >
          {initials || "in"}
        </div>
      )}
    </div>
  );
}
