import Image from "next/image";

// Thin wrapper around the SwipeIn logo so it can be passed as a nav `icon`
// component (matches lucide-react's `ComponentType<{ className?: string }>`
// signature). The other sidebar icons are lucide glyphs that inherit
// currentColor and recolor with the menu text — but the SwipeIn logo is a
// real multi-color mark (red + white shapes), not a single-stroke glyph, so
// we render it as-is. The className is forwarded for sizing only.
//
// Sized like the rest (h-4 w-4 by caller) and shrink-0 so the row layout
// doesn't squeeze it.
//
// next/image with a fixed 16/16 sizes hint avoids the optimizer round-trip
// for a tiny asset; `priority` would be wasted on a sidebar icon below the
// fold, so we leave it off.
export function SwipeInIcon({ className }: { className?: string }) {
  return (
    <Image
      src="/swipeInIcon.svg"
      alt=""
      width={16}
      height={16}
      aria-hidden
      className={className}
    />
  );
}
