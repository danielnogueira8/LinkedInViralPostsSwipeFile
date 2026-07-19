"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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
  useEffect(() => {
    if (reduced) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % phrases.length), 2600);
    return () => clearInterval(id);
  }, [reduced, phrases.length]);
  return (
    <span className="inline-grid align-baseline">
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
