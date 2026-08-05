"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Image from "next/image";
import { Check } from "lucide-react";
import { formatStatCount } from "@/lib/landing-stats";

/* Motion primitives for the marketing landing page. Everything here is
   monochrome (the only color is the small coral status accent) and every
   animation falls back to a static render under prefers-reduced-motion. */

function subscribeReducedMotion(onChange: () => void) {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

export function usePrefersReducedMotion() {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
}

/* Scroll-triggered fade-up. Wraps content in a div that starts translated
   and animates in the first time it enters the viewport. */
export function Reveal({
  children,
  className = "",
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.classList.add("is-visible");
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          el.classList.add("is-visible");
          io.disconnect();
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -40px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      className={`scroll-reveal ${className}`}
      style={{ "--reveal-delay": `${delay}ms` } as React.CSSProperties}
    >
      {children}
    </div>
  );
}

/* Interactive hero dot grid (reactbits DotGrid): a brighter copy of the dot
   field wakes up in a small radius around the cursor. The effect is pure CSS
   masking — this component only feeds --grid-x/y and data-active. Pointer
   tracking is skipped entirely on touch devices and under reduced motion, so
   the grid stays static in both cases. */
/**
 * Ink-wash landscape behind the hero copy.
 *
 * Replaces DotGridField rather than layering over it: the artwork is
 * stipple-engraved, so a dot grid on top of it produced two competing dot
 * textures that read as moiré instead of calm.
 *
 * Anchored bottom-left because that is where the drawing puts its subject —
 * the pagoda and treeline sit low-left, and the empty sky is deliberately the
 * space the headline occupies. `object-position` keeps that relationship when
 * the viewport crops the 3:2 frame.
 *
 * Opacity is very low by design (6% light / 4% dark): this is texture, not
 * imagery. The top mask fades it out entirely behind the headline so nothing
 * competes with the h1, and the whole layer is aria-hidden + pointer-events-none
 * because it carries no meaning and must never intercept a click.
 */
export function HeroLandscapeWash() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden select-none"
      style={{
        // Fade from fully transparent at the top (behind the headline) to
        // fully opaque toward the bottom, so the drawing emerges rather than
        // sitting flat behind the copy.
        // Reaches full strength by 55% rather than 100%.
        //
        // The first version ramped to opaque only at the very bottom of the
        // section. That was tuned against a SHORT hero; the real one is tall
        // enough that the copy area sat in the faint part of the ramp and the
        // drawing was effectively invisible — visible only as a sliver above
        // the product shot.
        //
        // The top stays clear so nothing competes with the h1.
        maskImage:
          "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.55) 22%, black 55%)",
        WebkitMaskImage:
          "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.55) 22%, black 55%)",
      }}
    >
      <Image
        src="/hero-landscape.webp"
        alt=""
        fill
        // Background texture: never block LCP on it. The headline is the LCP
        // element and must not wait behind a decorative layer.
        loading="lazy"
        sizes="100vw"
        // 6% was too faint to read as anything on the live page. 14% still sits
        // well behind the copy — the headline keeps full contrast — while the
        // pagoda and treeline are actually legible.
        className="object-cover object-[left_bottom] opacity-[0.14] dark:opacity-[0.08] dark:invert"
      />
    </div>
  );
}

export function BlurWords({
  text,
  baseDelay = 0,
  step = 45,
}: {
  text: string;
  baseDelay?: number;
  step?: number;
}) {
  const parts: React.ReactNode[] = [];
  text.split(" ").forEach((word, i) => {
    if (i > 0) parts.push(" ");
    parts.push(
      <span
        key={i}
        className="blur-word"
        style={{ "--reveal-delay": `${baseDelay + i * step}ms` } as React.CSSProperties}
      >
        {word}
      </span>,
    );
  });
  return <>{parts}</>;
}

/* Subtle magnetic pull on primary CTAs (reactbits Magnet): the button drifts
   a few px toward the cursor and eases back on leave. Hover-activated only —
   no proximity field — and skipped on touch and under reduced motion. */
export function Magnetic({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onMouseMove = (e: React.MouseEvent) => {
    const el = ref.current;
    if (!el) return;
    if (
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      window.matchMedia("(pointer: coarse)").matches
    ) {
      return;
    }
    const rect = el.getBoundingClientRect();
    const dx = e.clientX - (rect.left + rect.width / 2);
    const dy = e.clientY - (rect.top + rect.height / 2);
    el.style.transform = `translate(${dx * 0.18}px, ${dy * 0.28}px)`;
  };
  const onMouseLeave = () => {
    const el = ref.current;
    if (el) el.style.transform = "";
  };
  return (
    <div
      ref={ref}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      className={`magnetic ${className}`}
    >
      {children}
    </div>
  );
}

/* Counts up from zero the first time it scrolls into view. */
export function CountUp({ value }: { value: number }) {
  const reduced = usePrefersReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    if (reduced) return;
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        io.disconnect();
        const start = performance.now();
        const duration = 1400;
        const tick = (now: number) => {
          const t = Math.min(1, (now - start) / duration);
          const eased = 1 - Math.pow(1 - t, 3);
          setDisplay(Math.round(eased * value));
          if (t < 1) raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [reduced, value]);
  return <span ref={ref}>{formatStatCount(reduced ? value : display)}</span>;
}

/* Crossfades through a list of phrases. Phrases are stacked in the same
   grid cell so the container keeps the width of the longest one. */
export function RotatingPhrases({ phrases }: { phrases: string[] }) {
  const reduced = usePrefersReducedMotion();
  const [index, setIndex] = useState(0);
  // WCAG 2.2.2 — auto-updating content needs a pause mechanism: hover pauses
  // for mouse users, and the sr-only toggle gives keyboard/AT users the same
  // control without disturbing the layout.
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (reduced || paused) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % phrases.length), 2600);
    return () => clearInterval(id);
  }, [reduced, paused, phrases.length]);
  return (
    <span
      className="inline-grid align-baseline"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {phrases.map((phrase, i) => (
        <span
          key={phrase}
          aria-hidden={i !== index}
          className={`col-start-1 row-start-1 transition-[opacity,transform] duration-500 ${
            i === index ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0"
          }`}
        >
          {phrase}
        </span>
      ))}
      <button
        type="button"
        className="sr-only"
        onClick={() => setPaused((p) => !p)}
      >
        {paused ? "Play rotating phrases" : "Pause rotating phrases"}
      </button>
    </span>
  );
}

/* Card that lights up under the cursor — --spotlight-x/y feed the radial
   gradient in .spotlight-card (globals.css). */
export function SpotlightCard({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onMouseMove = (e: React.MouseEvent) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty("--spotlight-x", `${e.clientX - rect.left}px`);
    el.style.setProperty("--spotlight-y", `${e.clientY - rect.top}px`);
  };
  return (
    <div ref={ref} onMouseMove={onMouseMove} className={`spotlight-card ${className}`}>
      {children}
    </div>
  );
}

const TRACE_STEPS = [
  "Scanning 142 posts from 38 tracked creators…",
  "Breakout found · @elenamarsh at 3.2× baseline",
  "Extracting framework → hook / tension / payoff",
  "Drafting in your voice — held back 1 cliché",
  "Ready for your review",
];

const TICK_MS = 45;
const PAUSE_TICKS = 12; // pause after a step finishes typing
const HOLD_TICKS = 55; // hold the completed trace before looping

/* Looping agent activity trace. Each line types out, gets a check, and the
   sequence restarts — the hero's "the agent is alive" moment. */
export function AgentTrace() {
  const reduced = usePrefersReducedMotion();
  const [tick, setTick] = useState(0);

  const totalTicks =
    TRACE_STEPS.reduce((sum, step) => sum + step.length + PAUSE_TICKS, 0) + HOLD_TICKS;

  useEffect(() => {
    if (reduced) return;
    const id = setInterval(() => setTick((t) => (t + 1) % totalTicks), TICK_MS);
    return () => clearInterval(id);
  }, [reduced, totalTicks]);

  // Walk the timeline: each step owns `text.length` typing ticks followed by
  // a short pause. Anything past its range is fully typed + checked.
  const steps: { text: string; chars: number; done: boolean; active: boolean }[] = [];
  let cursor = tick;
  for (const text of TRACE_STEPS) {
    const span = text.length + PAUSE_TICKS;
    const chars = Math.max(0, Math.min(text.length, cursor));
    steps.push({
      text,
      chars,
      done: cursor >= span,
      active: cursor > 0 && cursor < span,
    });
    cursor -= span;
  }
  const finished = reduced || cursor >= 0;

  return (
    <div className="overflow-hidden rounded-[12px] border border-border bg-card shadow-soft-lg">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <span className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
          <span className="live-dot size-1.5 rounded-full bg-accent-brand" />
          {finished ? "Agent · ready for review" : "Agent · working"}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground/70">swipein</span>
      </div>
      <ul className="space-y-2 px-4 py-3.5 font-mono text-[11px] leading-5">
        {steps.map((step) => {
          if (reduced) {
            return (
              <li key={step.text} className="flex items-center gap-2 text-foreground">
                <Check className="size-3 shrink-0 text-muted-foreground" />
                {step.text}
              </li>
            );
          }
          if (step.chars === 0 && !step.done) {
            return (
              <li key={step.text} className="flex items-center gap-2 text-muted-foreground/50">
                <span className="size-3 shrink-0" />
                <span className="truncate">{step.text}</span>
              </li>
            );
          }
          return (
            <li
              key={step.text}
              className={`flex items-center gap-2 ${
                step.done ? "text-muted-foreground" : "text-foreground"
              }`}
            >
              {step.done ? (
                <Check className="check-pop size-3 shrink-0 text-muted-foreground" />
              ) : (
                <span className="size-3 shrink-0 rounded-full bg-foreground/15" />
              )}
              <span className="truncate">
                {step.text.slice(0, step.chars)}
                {step.active && step.chars < step.text.length && <span className="trace-caret" />}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
