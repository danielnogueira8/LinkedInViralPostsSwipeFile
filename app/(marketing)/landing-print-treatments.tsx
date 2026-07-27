"use client";

import Image from "next/image";
import { PaperTexture } from "@paper-design/shaders-react";

// The landing page uses only static, decorative shaders. Keeping their canvas
// budget capped prevents an editorial flourish from competing with the page's
// primary job: getting visitors into the product.
export const LANDING_SHADER_CONFIG = {
  paper: {
    speed: 0,
    minPixelRatio: 1,
    maxPixelCount: 320_000,
    // Mirrors the --paper-trail / --paper-trail-front tokens (globals.css) —
    // canvas shaders can't read CSS vars, so keep these in sync by hand.
    colorBack: "#f8f4e9",
    colorFront: "#cbbd9e",
    contrast: 0.18,
    roughness: 0.04,
    fiber: 0.2,
    fiberSize: 0.18,
    crumples: 0.08,
    crumpleSize: 0.35,
    folds: 0.08,
    foldCount: 3,
    drops: 0.03,
    seed: 28,
  },
} as const;

export const LANDING_SOURCE_MATERIAL_IMAGE = {
  src: "/swipe-file-posts.png",
  width: 2762,
  height: 1644,
} as const;

export function LandingPaperTexture({ className }: { className?: string }) {
  return (
    <PaperTexture
      {...LANDING_SHADER_CONFIG.paper}
      aria-hidden="true"
      className={className ?? "pointer-events-none absolute inset-0 h-full w-full opacity-75"}
      width="100%"
      height="100%"
    />
  );
}

export function LandingPaperPanel() {
  return (
    <div
      aria-hidden="true"
      className="relative min-h-72 overflow-hidden rounded-[14px] border border-paper-trail-edge bg-paper-trail p-2 shadow-soft sm:min-h-[360px] sm:p-3"
    >
      <LandingPaperTexture />
      <Image
        src={LANDING_SOURCE_MATERIAL_IMAGE.src}
        alt=""
        width={LANDING_SOURCE_MATERIAL_IMAGE.width}
        height={LANDING_SOURCE_MATERIAL_IMAGE.height}
        sizes="(max-width: 1023px) calc(100vw - 32px), 53vw"
        className="relative h-auto w-full rounded-[8px] outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
      />
      <div className="absolute inset-x-4 bottom-4 border border-paper-trail-ink/15 bg-paper-trail/90 px-4 py-3 backdrop-blur-sm sm:inset-x-6 sm:bottom-6">
        <p className="font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-paper-trail-ink/65">
          Swipe File / Paper trail
        </p>
      </div>
    </div>
  );
}
