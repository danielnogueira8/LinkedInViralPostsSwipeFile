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
    <figure className="my-10 flex justify-center">
      {avatarUrl && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element -- LinkedIn profile photos are external and may expire; this component handles fallback.
        <img
          src={avatarUrl}
          alt={displayName}
          onError={() => setBroken(true)}
          className="h-36 w-36 rounded-full border border-border/70 object-cover shadow-md"
          loading="lazy"
        />
      ) : (
        <div
          aria-label={displayName}
          className="grid h-36 w-36 place-items-center rounded-full border border-border/70 bg-primary/10 text-3xl font-semibold text-primary shadow-md"
        >
          {initials || "in"}
        </div>
      )}
    </figure>
  );
}
