// Small presentation helpers shared by the swipe PostCard and the chat's
// InlineSourceCard, so a cited source post reads identically to the same post
// in the swipe file (same avatar tint, same date format).

// Stable color from a name so each account has its own avatar tint.
// Warm palette to match the cream/coral design system.
const AVATAR_TINTS = [
  "bg-amber-100 text-amber-800",
  "bg-orange-100 text-orange-800",
  "bg-rose-100 text-rose-800",
  "bg-stone-200 text-stone-700",
  "bg-yellow-100 text-yellow-800",
  "bg-red-100 text-red-800",
  "bg-lime-100 text-lime-800",
  "bg-fuchsia-100 text-fuchsia-800",
];

export function tintFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_TINTS[Math.abs(h) % AVATAR_TINTS.length];
}

export function initialsForName(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => Array.from(part)[0] ?? "")
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

// Fallback avatar for creators whose profile photo is missing or whose
// LinkedIn CDN URL expired: a DiceBear "shapes" avatar (the glyphs style is
// Pro-only and 404s on the free API; shapes is the closest free geometric
// look). Seeded by the author
// name so each creator keeps one stable glyph across renders while different
// creators get different ones (no random flicker, CDN-cacheable). The initials
// tile stays as the final fallback when the DiceBear CDN itself is unreachable.
export function creatorAvatarFallback(name: string): string {
  return `https://api.dicebear.com/9.x/shapes/svg?seed=${encodeURIComponent(name.trim() || "?")}`;
}

export function timeAgo(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
