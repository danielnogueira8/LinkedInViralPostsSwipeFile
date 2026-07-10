"use client";

import type React from "react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  CalendarCheck,
  Check,
  FileText,
  Fingerprint,
  Flame,
  Gift,
  MessageCircle,
  Repeat2,
  Sparkles,
  ThumbsUp,
  TrendingUp,
  Zap,
  X,
} from "lucide-react";
import { ClaudeIcon } from "@/components/claude-icon";
import type { LandingStats } from "@/lib/landing-stats";
import { formatStatCount } from "@/lib/landing-stats";

/* ─────────────────────────────────────────────
   Shared atoms — pill Badge, dark pill CTA,
   pale pill ghost CTA, diagonal hatched corner.
   Tokens are inline so this page stays self-contained
   and follows the app's monochrome design system
   (see app/globals.css :root).
   ───────────────────────────────────────────── */

function PrimaryPill({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="h-10 sm:h-11 md:h-12 px-6 sm:px-8 md:px-10 lg:px-12 py-2 sm:py-[6px] relative bg-[#1C1C1A] shadow-[0px_0px_0px_2.5px_rgba(255,255,255,0.08)_inset] overflow-hidden rounded-full inline-flex justify-center items-center cursor-pointer hover:-translate-y-0.5 hover:bg-black active:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1C1C1A]/35 focus-visible:ring-offset-2 focus-visible:ring-offset-[#F4F4F3] transition-all"
    >
      <span className="flex flex-col justify-center whitespace-nowrap text-white text-sm sm:text-base md:text-[15px] font-medium leading-5 font-sans">
        {label}
      </span>
    </Link>
  );
}

/* ─────────────────────────────────────────────
   Page
   ───────────────────────────────────────────── */

export default function LandingClient({ stats }: { stats: LandingStats }) {
  return (
    <div className="w-full min-h-screen relative bg-[#F4F4F3] overflow-x-hidden flex flex-col justify-start items-center -mt-16">
      <div className="relative flex flex-col justify-start items-center w-full">
        <div className="w-full max-w-none px-4 sm:px-6 md:px-8 lg:px-0 lg:max-w-[1060px] lg:w-[1060px] relative flex flex-col justify-start items-start min-h-screen">
          {/* Left vertical rule */}
          <div className="w-[1px] h-full absolute left-4 sm:left-6 md:left-8 lg:left-0 top-0 bg-[rgba(28,28,26,0.12)] shadow-[1px_0px_0px_white] z-0" />
          {/* Right vertical rule */}
          <div className="w-[1px] h-full absolute right-4 sm:right-6 md:right-8 lg:right-0 top-0 bg-[rgba(28,28,26,0.12)] shadow-[1px_0px_0px_white] z-0" />

          <div className="self-stretch pt-[9px] overflow-hidden border-b border-[rgba(28,28,26,0.06)] flex flex-col justify-center items-center gap-4 sm:gap-6 md:gap-8 lg:gap-[66px] relative z-10">
            {/* Hero */}
            <Hero />

            {/* Creator logo strip — proof-first, frontal-style */}
            <CreatorStrip />

            {/* Product loop */}
            <WorkflowSection />

            {/* Numbers */}
            <NumbersSection stats={stats} />

            {/* Bento */}
            <BentoSection />

            {/* "vs the old way" comparison — frontal-style */}
            <ComparisonSection />

            {/* Pricing */}
            <PricingSection />

            {/* FAQ */}
            <FAQSection />

            {/* CTA */}
            <CTASection />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── HERO ─────────────────────────── */

function Hero() {
  return (
    <div className="w-full px-4 pb-6 pt-20 sm:px-6 md:px-8 md:pt-24 lg:px-0 lg:pt-[92px]">
      {/* Clean, centered product hero: a quiet pill eyebrow, a confident Geist
          headline, one line of subtext, two CTAs, then the live demo as a
          full-width centerpiece directly below. */}
      <div className="mx-auto flex max-w-[900px] flex-col items-center text-center">
        <RevealUp>
          <Link
            href="#features"
            className="inline-flex items-center gap-2 rounded-full border border-[rgba(28,28,26,0.12)] bg-white px-3 py-1.5 text-[13px] font-medium text-[#1C1C1A] shadow-sm transition-colors hover:bg-[#F0F0EF]"
          >
            <ClaudeIcon variant="brand" className="h-3.5 w-3.5" />
            Now with a one-click Claude MCP connector
          </Link>
        </RevealUp>
        <RevealUp delay={0.05}>
          {/* Stacked short-line headline: each clause on its own line, tight
              leading + tracking, the payoff line in the one coral accent
              moment on the whole page. */}
          <h1 className="mt-6 max-w-[12ch] text-[38px] font-semibold leading-[0.98] tracking-[-0.02em] text-[#1C1C1A] sm:max-w-none sm:text-[56px] lg:text-[68px]">
            From blank page
            <br />
            to <span className="text-[#E8623D]">booked calendar.</span>
          </h1>
        </RevealUp>
        <RevealUp delay={0.1}>
          <p className="mt-5 max-w-[50ch] text-base leading-relaxed text-[#5C5C58] sm:text-lg">
            SwipeIn turns proven LinkedIn patterns into drafts in your voice,
            then helps you plan, schedule, and publish them from one calendar.
          </p>
        </RevealUp>
        <RevealUp delay={0.15}>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <PrimaryPill href="/sign-up" label="Start for free" />
            <Link
              href="#pricing"
              className="flex h-12 items-center justify-center rounded-full border border-[rgba(28,28,26,0.14)] bg-white px-7 text-[15px] font-medium text-[#1C1C1A] shadow-sm transition-all hover:-translate-y-0.5 hover:bg-[#F0F0EF] active:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1C1C1A]/20 focus-visible:ring-offset-2 focus-visible:ring-offset-[#F4F4F3]"
            >
              See pricing
            </Link>
          </div>
        </RevealUp>
        <RevealUp delay={0.2}>
          <p className="mt-4 text-[13px] text-[#8A8A86]">
            7-day free trial. No credit card required.
          </p>
        </RevealUp>
      </div>

      {/* Live agent demo — the centerpiece, full width under the hero copy. */}
      <RevealUp delay={0.25} className="mx-auto mt-10 w-full max-w-[960px]">
        <div className="relative">
          <div
            aria-hidden
            className="pointer-events-none absolute -inset-x-6 -top-8 bottom-0 -z-10"
          >
            <svg viewBox="0 0 800 400" className="h-full w-full opacity-30 mix-blend-multiply">
              <defs>
                <radialGradient id="heroGlow" cx="50%" cy="35%" r="55%">
                  <stop offset="0%" stopColor="#1C1C1A" stopOpacity="0.14" />
                  <stop offset="55%" stopColor="#E8E8E6" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="#F4F4F3" stopOpacity="0" />
                </radialGradient>
              </defs>
              <ellipse cx="400" cy="180" rx="380" ry="180" fill="url(#heroGlow)" />
            </svg>
          </div>
          <div className="h-[300px] overflow-hidden rounded-xl bg-white shadow-[0px_1px_2px_rgba(28,28,26,0.06),0px_12px_40px_-12px_rgba(28,28,26,0.18)] ring-1 ring-[rgba(28,28,26,0.08)] sm:h-[340px] md:h-[360px]">
            <LiveAgentDemo />
          </div>
        </div>
      </RevealUp>
    </div>
  );
}

/* ─────────────────────── CREATOR STRIP ─────────────────────── */

// A quiet "logos" row (frontal-style social proof), but honest: these are
// PUBLIC creators whose posts you can track and learn from — NOT customers or
// endorsers of SwipeIn. Framed as "learn from the best", so it's proof of the
// content library, not a fake testimonial wall.
function CreatorStrip() {
  const creators = [
    { name: "Justin Welsh", stat: "hooks", initials: "JW" },
    { name: "Lara Acosta", stat: "voice", initials: "LA" },
    { name: "Sahil Bloom", stat: "story", initials: "SB" },
    { name: "Jasmin Alić", stat: "carousels", initials: "JA" },
    { name: "Hatice Kamran", stat: "offers", initials: "HK" },
    { name: "Kyle Coleman", stat: "sales", initials: "KC" },
  ];
  return (
    <section className="w-full border-b border-[rgba(28,28,26,0.12)] px-4 py-10 sm:px-6 md:px-8 lg:px-12">
      <div className="mx-auto flex max-w-[960px] flex-col gap-6 md:flex-row md:items-center md:justify-between">
        <div className="max-w-[34ch]">
          <p className="text-[13px] font-medium text-[#8A8A86]">
            Creator signals, pulled daily.
          </p>
          <h2 className="mt-1 text-2xl font-semibold leading-tight tracking-tight text-[#1C1C1A] sm:text-3xl">
            Study the creators your audience already reads.
          </h2>
        </div>
        <div className="grid flex-1 grid-cols-2 gap-2 sm:grid-cols-3">
          {creators.map((creator) => (
            <div
              key={creator.name}
              className="group flex items-center gap-2 rounded-xl border border-[#E8E8E6] bg-white/70 px-3 py-2 shadow-[0px_1px_2px_rgba(28,28,26,0.04)] transition-all hover:-translate-y-0.5 hover:bg-white hover:shadow-[0px_10px_24px_-18px_rgba(28,28,26,0.45)]"
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#1C1C1A] text-[11px] font-semibold text-white">
                {creator.initials}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-semibold leading-tight text-[#1C1C1A]">
                  {creator.name}
                </span>
                <span className="block text-[11px] text-[#8A8A86]">
                  {creator.stat} patterns
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function WorkflowSection() {
  const steps = [
    {
      k: "01",
      title: "Find the angle",
      body: "SwipeIn pulls the posts already breaking out in your niche, then shows the pattern worth borrowing.",
    },
    {
      k: "02",
      title: "Draft in your voice",
      body: "The agent reads your voice profile before writing, so the output starts closer to you.",
    },
    {
      k: "03",
      title: "Schedule the post",
      body: "Approved drafts land where you can plan the week or connect LinkedIn and schedule the post directly.",
    },
  ];
  return (
    <section className="w-full border-b border-[rgba(28,28,26,0.12)] px-4 py-16 sm:px-6 md:px-8 md:py-24 lg:px-12">
      <div className="mx-auto grid max-w-[960px] gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
        <div className="lg:sticky lg:top-8">
          <p className="text-[13px] font-medium text-[#8A8A86]">The operating loop</p>
          <h2 className="mt-2 text-3xl font-semibold leading-tight tracking-tight text-[#1C1C1A] sm:text-4xl">
            Research, draft, schedule. No context switching.
          </h2>
          <p className="mt-4 max-w-[46ch] text-base leading-relaxed text-[#5C5C58]">
            SwipeIn keeps discovery, drafting, planning, and scheduling in one
            workspace so every post has a clear next step.
          </p>
        </div>
        <div className="space-y-3">
          {steps.map((step) => (
            <article
              key={step.k}
              className="grid gap-4 rounded-2xl border border-[#E8E8E6] bg-[#F0F0EF] p-5 shadow-[0px_1px_2px_rgba(28,28,26,0.04)] transition-all hover:-translate-y-0.5 hover:bg-white sm:grid-cols-[72px_1fr] sm:p-6"
            >
              <div className="font-mono text-[12px] text-[#5C5C58]">{step.k}</div>
              <div>
                <h3 className="text-lg font-semibold tracking-tight text-[#1C1C1A]">
                  {step.title}
                </h3>
                <p className="mt-1.5 max-w-[52ch] text-sm leading-relaxed text-[#5C5C58]">
                  {step.body}
                </p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────── COMPARISON ─────────────────────── */

// "The old way vs SwipeIn" — frontal's "vs the usual fixes" table, in the warm
// palette. Two columns: the painful status quo (muted) vs SwipeIn (accented
// with checks). Reinforces the workflow positioning by contrast.
function ComparisonSection() {
  const rows = [
    { old: "Doomscroll the feed for post ideas", now: "A daily swipe file of what's already going viral" },
    { old: "Stare at a blank page (or generic AI mush)", now: "Drafts in your voice, grounded in what works" },
    { old: "Ideas scattered across notes and DMs", now: "One pipeline: idea → drafting → ready → posted" },
    { old: "Forget to post, or scramble day-of", now: "A calendar you can plan or schedule from" },
  ];
  return (
    <section className="w-full border-b border-[rgba(28,28,26,0.12)] px-4 py-16 sm:px-6 md:px-8 md:py-24 lg:px-12">
      <div className="mx-auto mb-10 max-w-[620px] text-center">
        <h2 className="text-3xl font-semibold tracking-tight text-[#1C1C1A] sm:text-4xl">
          The old way vs SwipeIn
        </h2>
        <p className="mx-auto mt-4 max-w-[48ch] text-base leading-relaxed text-[#5C5C58]">
          Same goal — show up on LinkedIn consistently. One of these is a grind.
        </p>
      </div>

      <div className="mx-auto grid max-w-[860px] gap-4 sm:grid-cols-2">
        {/* Old way column */}
        <div className="rounded-2xl border border-[#E8E8E6] bg-[#F0F0EF] p-6 sm:p-7">
          <div className="mb-4 text-[13px] font-semibold uppercase tracking-[0.1em] text-[#8A8A86]">
            Without SwipeIn
          </div>
          <ul className="space-y-3.5">
            {rows.map((r) => (
              <li key={r.old} className="flex items-start gap-2.5 text-[14.5px] leading-snug text-[#5C5C58]">
                <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-[#E8E8E6] text-[10px] text-[#8A8A86]">
                  <X className="h-2.5 w-2.5" aria-hidden />
                </span>
                {r.old}
              </li>
            ))}
          </ul>
        </div>

        {/* SwipeIn column — accented */}
        <div className="rounded-2xl border border-[#1C1C1A]/15 bg-white p-6 shadow-[0px_12px_40px_-16px_rgba(28,28,26,0.25)] sm:p-7">
          <div className="mb-4 flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.1em] text-[#1C1C1A]">
            With SwipeIn
          </div>
          <ul className="space-y-3.5">
            {rows.map((r) => (
              <li key={r.now} className="flex items-start gap-2.5 text-[14.5px] leading-snug text-[#1C1C1A]">
                <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-[#1C1C1A] text-[10px] text-white">
                  <Check className="h-2.5 w-2.5" aria-hidden />
                </span>
                {r.now}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

// Entrance fade-up wrapper. CSS-only (no Motion dependency): applies `.reveal-up`
// with a per-element stagger delay. Honors prefers-reduced-motion via the CSS.
function RevealUp({
  children,
  delay = 0,
  className = "",
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <div
      className={`reveal-up ${className}`}
      style={{ "--reveal-delay": `${delay * 1000}ms` } as React.CSSProperties}
    >
      {children}
    </div>
  );
}

/* ─────────────────────────── LIVE AGENT DEMO ───────────────────────────
   The hero's centerpiece. A self-driving demo of the actual product: the user
   "asks" Claude for a post, the agent narrates the work it does (the same
   activity stream + voice the real chat uses), then a full draft streams in.

   Built as one deterministic phase machine on a single frame ticker — no
   randomness, so it renders identically every time. It runs ONE pass on mount
   and holds the finished draft (it's shown permanently — no carousel — so it
   never gets swapped out). Honors prefers-reduced-motion by skipping straight
   to the finished end-state.

   Palette + chrome match the Bento visuals' dark shells exactly (#1C1C1A
   panel, neutral gray text tiers, green check) so it reads as part of the
   same design system, not a bolted-on widget.
   ─────────────────────────────────────────────────────────────────────── */

const DEMO_PROMPT = "write me a hook in my voice about niching down";

// The agent's narrated steps — same phrasing as the product's real activity
// stream (lib/agent tools → chat-workspace TOOL_PHRASES).
const DEMO_STEPS = [
  { label: "Read your voice profile" },
  { label: "Searched the swipe file", detail: "1,204 posts" },
  { label: "Matched 3 hook patterns" },
];

// A full post draft (hook + body + list + CTA), so the card fills the hero
// frame instead of leaving dead space below a two-line hook.
const DEMO_DRAFT = `Most founders treat LinkedIn like a megaphone.

The ones who win treat it like a conversation.

I niched down 18 months ago and everything changed:

→ Replies went from crickets to 40+ a post
→ DMs started with "I've been following you" not "buy my thing"
→ My calendar booked itself

Stop posting for everyone. Start posting for someone.

Who are you actually writing for?`;

// Phase boundaries in frames (one frame = TICK_MS). One pass: type prompt →
// three steps land → full draft streams → hold. No deadline now that the demo
// is permanent, so it's paced calmly (~9s to fully stream, then holds).
const TICK_MS = 55;
const DRAFT_PER_FRAME = 3; // chars streamed per frame (brisk; the draft is long)
const F = (() => {
  const typeStart = 3;
  const typeEnd = typeStart + DEMO_PROMPT.length; // one frame per prompt char
  const step1 = typeEnd + 8;
  const step2 = step1 + 13;
  const step3 = step2 + 13;
  const draftStart = step3 + 12;
  const draftEnd = draftStart + Math.ceil(DEMO_DRAFT.length / DRAFT_PER_FRAME);
  return { typeStart, typeEnd, step1, step2, step3, draftStart, draftEnd };
})();

// The hero's live product demo. Runs its pass once on mount and holds the
// finished draft. No internal loop / no remount; reduced-motion skips straight
// to the end state.
function LiveAgentDemo() {
  // Read reduced-motion once at mount (lazy initializer — guarded for SSR,
  // where window is undefined). Avoids a setState-in-effect to flip it.
  const [reduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [frame, setFrame] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (reduced) return;
    const id = setInterval(() => {
      // Run once: stop ticking at draftEnd and hold the finished state.
      setFrame((f) => (f >= F.draftEnd ? f : f + 1));
    }, TICK_MS);
    return () => clearInterval(id);
  }, [reduced]);

  // Keep the latest streamed content in view (matters on the short mobile
  // frame, where the full draft is taller than the viewport).
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [frame]);

  // Derive everything from the single frame counter (or jump to the end state
  // under reduced motion).
  const typedChars = reduced
    ? DEMO_PROMPT.length
    : Math.max(0, Math.min(DEMO_PROMPT.length, frame - F.typeStart));
  const typedPrompt = DEMO_PROMPT.slice(0, typedChars);
  const promptDone = reduced || frame >= F.typeEnd;

  const stepsShown = reduced
    ? DEMO_STEPS.length
    : (frame >= F.step1 ? 1 : 0) +
      (frame >= F.step2 ? 1 : 0) +
      (frame >= F.step3 ? 1 : 0);

  const draftChars = reduced
    ? DEMO_DRAFT.length
    : Math.max(
        0,
        Math.min(DEMO_DRAFT.length, (frame - F.draftStart) * DRAFT_PER_FRAME),
      );
  const draftText = DEMO_DRAFT.slice(0, draftChars);
  const draftStarted = reduced || frame >= F.draftStart;
  const draftDone = reduced || frame >= F.draftEnd;

  // A blinking caret while actively typing the prompt or the draft.
  const caretOnPrompt = !reduced && !promptDone && frame >= F.typeStart;
  const caretOnDraft = !reduced && draftStarted && !draftDone;

  return (
    <div className="w-full h-full bg-[#1C1C1A] flex flex-col overflow-hidden">
      {/* Connection bar — mirrors the Bento visuals' dark-shell header */}
      <div className="flex items-center gap-2 px-4 sm:px-5 py-2.5 sm:py-3 border-b border-white/[0.07] shrink-0">
        <ClaudeIcon variant="brand" className="h-3.5 w-3.5" />
        <span className="font-mono text-[10px] sm:text-[11px] text-[#A0A09C]">
          claude · swipe-file connected
        </span>
        <span className="ml-auto h-1.5 w-1.5 rounded-full bg-emerald-400" />
      </div>

      {/* Conversation. A full post fits the desktop frame; on the short mobile
          frame the area scrolls (scrollbar hidden) and auto-pins to the bottom
          as the draft streams, so the latest line is always in view and nothing
          hard-clips. */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto no-scrollbar px-4 sm:px-6 md:px-8 py-3 sm:py-6 md:py-8 flex flex-col gap-2 sm:gap-4"
      >
        {/* The user prompt, typing in */}
        <div className="font-mono text-[12px] sm:text-[13px] md:text-[15px] text-[#E8E8E6] leading-relaxed">
          <span className="text-[#8A8A86]">&gt; </span>
          {typedPrompt}
          {caretOnPrompt && (
            <span className="inline-block w-[7px] -mb-0.5 h-[1.05em] bg-[#E8E8E6]/70 animate-pulse" />
          )}
        </div>

        {/* Narrated activity stream */}
        {stepsShown > 0 && (
          <div className="flex flex-col gap-1.5 sm:gap-2 border-l-2 border-white/10 pl-3 sm:pl-3.5">
            {DEMO_STEPS.slice(0, stepsShown).map((s) => (
              <div
                key={s.label}
                className="flex items-center gap-2 font-mono text-[11px] sm:text-[12px] md:text-[13px] text-[#A0A09C] agent-step-in"
              >
                <CheckGlyph />
                <span>
                  {s.label}
                  {s.detail && (
                    <span className="text-[#8A8A86]"> · {s.detail}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}

        {!draftStarted && (
          <div className="mt-2 sm:mt-3 rounded-xl border border-white/[0.08] bg-white/[0.04] p-3.5 sm:p-5 agent-step-in">
            <div className="flex items-center gap-2 text-[10px] sm:text-[11px] font-medium text-[#A0A09C]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#E8E8E6]" />
              Preparing a draft card
            </div>
            <div className="mt-4 space-y-2.5">
              <div className="h-2.5 w-3/4 rounded-full bg-white/10" />
              <div className="h-2.5 w-full rounded-full bg-white/10" />
              <div className="h-2.5 w-5/6 rounded-full bg-white/10" />
              <div className="h-2.5 w-2/3 rounded-full bg-white/10" />
            </div>
          </div>
        )}

        {/* Streaming draft card. Mirrors the in-app draft card: soft white
            surface, rounded, subtle border + shadow lifting it off the dark
            panel. mt-2/3 separates it from the activity steps above. */}
        {draftStarted && (
          <div className="mt-2 sm:mt-3 rounded-xl border border-black/5 bg-white p-3.5 sm:p-5 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.45)] agent-step-in">
            <div className="flex items-center gap-2 mb-2 sm:mb-2.5">
              <div className="h-5 w-5 sm:h-6 sm:w-6 rounded-full bg-[#E8E8E6] shrink-0" />
              <span className="font-sans text-[10px] sm:text-[11px] font-semibold text-[#1C1C1A]">
                Your draft
              </span>
              <span className="ml-auto px-2 py-0.5 rounded-full bg-[#F0F0EF] text-[#8A8A86] text-[8px] sm:text-[9px] font-medium uppercase tracking-[0.12em] font-sans">
                Draft
              </span>
            </div>
            <div className="font-sans text-[11px] sm:text-[12.5px] md:text-[13.5px] leading-relaxed text-[#1C1C1A] whitespace-pre-wrap">
              {draftText}
              {caretOnDraft && (
                <span className="inline-block w-[6px] -mb-0.5 h-[1.05em] bg-[#1C1C1A]/40 animate-pulse" />
              )}
            </div>
          </div>
        )}

        {/* Trailing spacer — guarantees breathing room below the draft card.
            A scroll container's bottom padding is collapsed/ignored once content
            overflows (so the card would otherwise butt against the panel edge);
            an explicit shrink-0 spacer reliably reserves the gap. */}
        <div className="h-3 sm:h-5 md:h-6 shrink-0" aria-hidden />
      </div>
    </div>
  );
}

// Tiny check glyph for the demo's activity steps — drawn inline (matching the
// pixel-line icon style elsewhere on the page) and tinted emerald to read as
// "done", same as the product's real activity stream.
function CheckGlyph() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 12 12"
      fill="none"
      className="shrink-0"
      aria-hidden
    >
      <path
        d="M10 3L4.5 8.5L2 6"
        stroke="#5DCAA5"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ─────────────────────────── NUMBERS ─────────────────────────── */

function NumbersSection({ stats }: { stats: LandingStats }) {
  // Live counts from lib/landing-stats. A clean, balanced credibility band —
  // four equal stats with a hairline divider, Geist tabular numerals.
  const display = [
    { label: "Posts pulled this morning", value: formatStatCount(stats.postsPulledToday) },
    { label: "Creators tracked", value: formatStatCount(stats.creatorsTracked) },
    { label: "Viral posts archived", value: formatStatCount(stats.viralPostsArchived) },
    { label: "Templates generated", value: formatStatCount(stats.templatesGenerated) },
  ];
  return (
    <section className="w-full border-b border-[rgba(28,28,26,0.12)] px-4 py-12 sm:px-6 md:px-8 md:py-16 lg:px-12">
      <div className="grid grid-cols-2 gap-y-8 lg:grid-cols-4">
        {display.map((s, i) => (
          <div
            key={s.label}
            className={`flex flex-col items-center px-2 text-center ${
              i > 0 ? "lg:border-l lg:border-[rgba(28,28,26,0.1)]" : ""
            }`}
          >
            <div className="text-4xl font-semibold tracking-tight text-[#1C1C1A] tabular-nums lg:text-5xl">
              {s.value}
            </div>
            <div className="mt-2 text-[13px] text-[#5C5C58]">{s.label}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ─────────────────────────── BENTO ─────────────────────────── */

function BentoSection() {
  return (
    <section id="features" className="w-full border-b border-[rgba(28,28,26,0.12)] px-4 py-16 sm:px-6 md:px-8 md:py-24 lg:px-12">
      {/* Centered product section header. */}
      <div className="mx-auto mb-12 max-w-[620px] text-center">
        <h2 className="text-3xl font-semibold tracking-tight text-[#1C1C1A] sm:text-4xl">
          Everything from idea to posted.
        </h2>
        <p className="mx-auto mt-4 max-w-[52ch] text-base leading-relaxed text-[#5C5C58]">
          Research, drafting, planning, and LinkedIn scheduling in one place,
          not five tabs and a spreadsheet.
        </p>
      </div>

      {/* 10-cell feature grid — asymmetric rather than equal tiles, with
          product-shaped visuals in every cell. grid-flow-dense prevents dead
          gaps if the spans wrap at intermediate widths. */}
      <div className="grid grid-flow-dense grid-cols-1 gap-5 md:grid-cols-6">
        <BentoCell
          className="md:col-span-4"
          title="AI that writes in your voice"
          blurb="Ask for a post; the agent studies your voice profile and what's working in your niche, then drafts it — ready to refine or ship."
        >
          <BentoChatVisual />
        </BentoCell>
        <BentoCell
          className="md:col-span-2"
          title="Your content calendar"
          blurb="Every draft lands on a calendar you can actually keep. Plan the week, see what's due, or connect LinkedIn and schedule it to publish."
        >
          <BentoCalendarVisual />
        </BentoCell>
        <BentoCell
          className="md:col-span-3"
          title="A pipeline, idea to posted"
          blurb="Drag a card from idea to drafting to ready to posted. Your whole content backlog in one board, not scattered across notes."
        >
          <BentoPipelineVisual />
        </BentoCell>
        <BentoCell
          className="md:col-span-3"
          title="Daily viral swipe file"
          blurb="Fresh every morning: the top posts from 100 creators you pick. Filter by niche, date, or virality — or let the agent surface them."
        >
          <BentoSwipeVisual />
        </BentoCell>
        <BentoCell
          className="md:col-span-2"
          title="Bookmark what inspires you"
          blurb="Save any post to your own library as you browse. Build a private stash of proven angles you can pull into a draft whenever you're stuck."
        >
          <BentoBookmarksVisual />
        </BentoCell>
        <BentoCell
          className="md:col-span-4"
          title="A voice profile that's really you"
          blurb="We learn how you write from your own posts — your tone, your structure, your phrasing — so every AI draft sounds like you, not a robot."
        >
          <BentoVoiceVisual />
        </BentoCell>
        <BentoCell
          className="md:col-span-3"
          title="Creator styles you can borrow"
          blurb="Reusable writing-style profiles from creators you track. Pull an extracted style straight into a draft instead of guessing at their formula."
        >
          <BentoCreatorStyleVisual />
        </BentoCell>
        <BentoCell
          className="md:col-span-3"
          title="Custom skills that shape drafts"
          blurb="Instructions and examples that shape how drafts are written. Save a skill once, then trigger it with a slash command from any chat."
        >
          <BentoSkillsVisual />
        </BentoCell>
        <BentoCell
          className="md:col-span-2"
          title="Lead magnets, built in"
          blurb="Create and share markdown resources for lead-magnet posts. Attach one to a draft so the giveaway ships alongside the post."
        >
          <BentoLeadMagnetVisual />
        </BentoCell>
        <BentoCell
          className="md:col-span-4"
          title="A week of drafts in one click"
          blurb="Generate a week of drafts in one click. The agent finds top posts, adapts them in your voice, and drops them on the board ready to review."
        >
          <BentoWeeklyBatchVisual />
        </BentoCell>
      </div>
    </section>
  );
}

function BentoCell({
  title,
  blurb,
  children,
  className = "",
}: {
  title: string;
  blurb: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`group flex flex-col gap-5 rounded-xl border border-[#E8E8E6] bg-[#F0F0EF] p-6 shadow-sm transition-all hover:-translate-y-1 hover:border-[rgba(28,28,26,0.2)] hover:bg-white hover:shadow-[0px_18px_44px_-28px_rgba(28,28,26,0.5)] sm:p-7 ${className}`}>
      <div className="flex flex-col gap-2">
        <h3 className="text-lg font-semibold tracking-tight text-[#1C1C1A]">{title}</h3>
        <p className="text-sm leading-relaxed text-[#5C5C58]">{blurb}</p>
      </div>
      <div className="relative flex min-h-[240px] w-full flex-1 items-stretch justify-center overflow-hidden rounded-lg">
        {children}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-[#F0F0EF] to-transparent" />
      </div>
    </div>
  );
}

/* Bento visuals — all in HTML/SVG, no external assets */

// One real swipe-file card — mirrors the actual product card (post-card.tsx):
// author + niche + the "% viral hit rate" flame chip, a text preview, a GRAPHIC
// media block with a "graphic" badge, the LinkedIn engagement row, and the
// "×their norm" breakout chip. These intelligence signals (hit rate, breakout
// multiple, media) are what make it a research tool, not a plain feed. A second
// card peeks behind it so it reads as a scrollable grid.
function BentoSwipeVisual() {
  return (
    <div className="relative w-full h-full">
      {/* Peeking card behind, for depth (it's a grid, not a single post). */}
      <div className="absolute inset-x-3 top-3 bottom-0 rounded-md border border-[#E8E8E6] bg-white/70 shadow-[0px_2px_4px_rgba(28,28,26,0.03)]" />
      <div className="relative flex h-full flex-col rounded-md border border-[#E8E8E6] bg-white p-3 shadow-[0px_3px_8px_rgba(28,28,26,0.06)]">
        {/* Header: avatar, name, viral-hit-rate chip, niche */}
        <div className="flex items-center gap-2">
          <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-rose-100 text-[10px] font-semibold text-rose-700">
            LA
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-[12px] font-semibold leading-tight text-[#1C1C1A] font-sans">
                Lara Acosta
              </span>
              <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-medium text-emerald-700 font-sans">
                <Flame className="h-2.5 w-2.5 fill-current" aria-hidden />
                73% viral hit rate
              </span>
            </div>
            <div className="text-[10px] text-[#8A8A86] font-sans">
              Personal Branding · 2d ago
            </div>
          </div>
        </div>
        {/* Text preview */}
        <p className="mt-2 text-[11.5px] leading-snug text-[#1C1C1A] line-clamp-2 font-sans">
          The 5 hooks I used to go from 0 to 200k followers — steal every one of
          them for your next post.
        </p>
        {/* Graphic media block with the "graphic" badge */}
        <div className="relative mt-2 flex-1 overflow-hidden rounded border border-[#E8E8E6] bg-gradient-to-br from-[#F0F0EF] via-[#F4F4F3] to-[#E8E8E6]">
          <div className="absolute inset-0 grid place-items-center">
            <div className="rounded bg-white/70 px-2.5 py-1 text-[10px] font-semibold text-[#5C5C58] font-sans backdrop-blur-sm">
              5 HOOKS THAT WENT VIRAL
            </div>
          </div>
          <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[8.5px] font-medium text-white font-sans">
            graphic
          </span>
        </div>
        {/* Engagement row + breakout chip */}
        <div className="mt-2 flex items-center gap-2.5 text-[10.5px] text-[#5C5C58] font-sans">
          <span className="flex items-center gap-1 text-[#1C1C1A] font-medium tabular-nums">
            <span className="grid h-3.5 w-3.5 place-items-center rounded-full bg-[#1C1C1A]/10 text-[#1C1C1A]">
              <ThumbsUp className="h-2.5 w-2.5" aria-hidden />
            </span>
            12.4k
          </span>
          <span className="flex items-center gap-1 tabular-nums">
            <MessageCircle className="h-3 w-3" aria-hidden />
            842
          </span>
          <span className="flex items-center gap-1 tabular-nums">
            <Repeat2 className="h-3 w-3" aria-hidden />
            310
          </span>
          <span className="ml-auto inline-flex items-center gap-0.5 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-medium text-emerald-700">
            <TrendingUp className="h-2.5 w-2.5" aria-hidden />
            2.4× their norm
          </span>
        </div>
      </div>
    </div>
  );
}

// The agent drafting in your voice — the product's dark shell (matches the
// hero LiveAgentDemo + old MCP visual chrome), reframed around the CHAT feature:
// you ask, it studies your voice, a post streams back.
function BentoChatVisual() {
  return (
    <div className="w-full h-full bg-[#1C1C1A] rounded-md p-4 shadow-[0px_2px_4px_rgba(28,28,26,0.08)] font-mono text-[11px] md:text-[12px] leading-relaxed text-[#E8E8E6] flex flex-col">
      <div className="flex items-center gap-1.5 text-[10px] text-[#A0A09C]">
        <ClaudeIcon variant="brand" className="h-3 w-3" />
        swipein · chat
      </div>
      <div className="mt-3 text-[#E8E8E6]">
        &gt; write me a post about hiring for curiosity
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-[10px] text-[#A0A09C]">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
        reading your voice profile · matching what&apos;s working
      </div>
      <div className="mt-2.5 rounded bg-[#141412] px-2.5 py-2 text-[#E8E8E6] font-sans text-[11px] leading-snug">
        <span className="text-white font-semibold">
          I stopped reading resumes.
        </span>{" "}
        Now I ask one question: &ldquo;What&apos;s the last thing you got
        obsessed with?&rdquo; It tells me more than a decade of…
      </div>
      <div className="mt-2 flex items-center gap-2 text-[10px] text-[#A0A09C]">
        <span className="rounded-sm bg-white/10 px-1.5 py-0.5 text-[#E8E8E6]">
          in your voice
        </span>
        <span className="text-[#8A8A86]">draft ready · refine or ship</span>
      </div>
    </div>
  );
}

// The content calendar — a compact month grid with post cards on a few days
// (idea / ready / posted status dots), on the paper surface.
function BentoCalendarVisual() {
  // A tiny 5-col week strip is more legible at this size than a full month.
  const days = [
    { d: "Mon", n: 12 },
    { d: "Tue", n: 13, post: { label: "Hiring post", tone: "ready" as const } },
    { d: "Wed", n: 14 },
    { d: "Thu", n: 15, post: { label: "Lead magnet", tone: "idea" as const } },
    { d: "Fri", n: 16, post: { label: "Founder story", tone: "posted" as const } },
  ];
  const toneClass = {
    idea: "bg-[#F0F0EF] text-[#8A8A86]",
    ready: "bg-[#E8E8E6] text-[#1C1C1A]",
    posted: "bg-emerald-50 text-emerald-700",
  };
  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex-1 bg-white border border-[#E8E8E6] rounded-md p-3 shadow-[0px_2px_4px_rgba(28,28,26,0.04)] flex flex-col">
        <div className="flex items-center justify-between px-0.5">
          <span className="text-[11px] font-semibold text-[#1C1C1A] font-sans">
            This week
          </span>
          <span className="text-[10px] text-[#8A8A86] font-sans">March</span>
        </div>
        <div className="mt-2 grid flex-1 grid-cols-5 gap-1.5">
          {days.map((day) => (
            <div
              key={day.d}
              className="flex flex-col rounded border border-[#F0F0EF] bg-[#F4F4F3] p-1.5"
            >
              <div className="text-[9px] uppercase tracking-[0.08em] text-[#8A8A86] font-sans">
                {day.d}
              </div>
              <div className="text-[11px] font-semibold text-[#1C1C1A] font-sans tabular-nums">
                {day.n}
              </div>
              {day.post && (
                <div
                  className={`mt-auto rounded-sm px-1 py-0.5 text-[8.5px] font-medium leading-tight font-sans ${toneClass[day.post.tone]}`}
                >
                  {day.post.label}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-3 px-1 text-[10px] text-[#5C5C58] font-sans">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-[#8A8A86]/50" />
          Idea
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-[#1C1C1A]/60" />
          Ready
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
          Posted
        </span>
      </div>
    </div>
  );
}

// The pipeline board — the four real statuses (idea → drafting → ready →
// posted) as compact columns with a card or two each.
function BentoPipelineVisual() {
  const cols = [
    { name: "Idea", cards: ["Cold outreach myth"], accent: "text-[#8A8A86]" },
    { name: "Drafting", cards: ["Hiring post"], accent: "text-[#5C5C58]" },
    { name: "Ready", cards: ["Founder story"], accent: "text-[#3E7C59]" },
    { name: "Posted", cards: ["$2M lesson"], accent: "text-[#8A8A86]" },
  ];
  return (
    <div className="w-full h-full flex flex-col justify-center">
      <div className="grid grid-cols-4 gap-1.5">
        {cols.map((col) => (
          <div key={col.name} className="flex flex-col gap-1.5">
            <div
              className={`text-[9px] font-semibold uppercase tracking-[0.06em] font-sans ${col.accent}`}
            >
              {col.name}
            </div>
            {col.cards.map((c) => (
              <div
                key={c}
                className="rounded border border-[#E8E8E6] bg-white px-1.5 py-1.5 text-[9.5px] font-medium leading-tight text-[#1C1C1A] shadow-[0px_1px_2px_rgba(28,28,26,0.04)] font-sans"
              >
                {c}
              </div>
            ))}
            {/* an empty ghost slot so columns look like a real board */}
            <div className="rounded border border-dashed border-[#E8E8E6] px-1.5 py-1.5" />
          </div>
        ))}
      </div>
      <div className="mt-3 px-1 text-[10px] text-[#5C5C58] font-sans">
        Drag a card to move it along →
      </div>
    </div>
  );
}

// Bookmarks — an ORGANIZED library that feeds the drafting loop. Leads with the
// niche/tag filter chips (Hooks / Frameworks / Lead magnets) + a saved count, so
// it reads as a sorted collection, not a flat list — then one saved card with
// the real "Ask AI → Model in my voice" action that connects a bookmark straight
// to the chat. Mirrors saved-post-card.tsx (niche chips + AskAiMenu).
function BentoBookmarksVisual() {
  const chips = [
    { label: "All", n: 38, active: true },
    { label: "Hooks", n: 14 },
    { label: "Frameworks", n: 11 },
    { label: "Lead magnets", n: 7 },
  ];
  return (
    <div className="w-full h-full flex flex-col">
      {/* Tag/niche organization row */}
      <div className="flex flex-wrap items-center gap-1.5">
        {chips.map((c) => (
          <span
            key={c.label}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium font-sans ${
              c.active
                ? "bg-[#1C1C1A] text-white"
                : "bg-[#F0F0EF] text-[#8A8A86]"
            }`}
          >
            {c.label}
            <span className="tabular-nums opacity-70">{c.n}</span>
          </span>
        ))}
      </div>
      {/* One saved card with the Ask-AI action wired to drafting */}
      <div className="mt-2.5 flex-1 rounded-md border border-[#E8E8E6] bg-white p-3 shadow-[0px_2px_4px_rgba(28,28,26,0.04)] flex flex-col">
        <div className="flex items-center gap-2">
          <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-emerald-100 text-[10px] font-semibold text-emerald-700">
            JW
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="text-[12px] font-semibold leading-tight text-[#1C1C1A] font-sans">
                Justin Welsh
              </span>
              <span className="rounded-sm bg-[#F0F0EF] px-1 py-0.5 text-[8.5px] font-medium uppercase tracking-[0.06em] text-[#5C5C58] font-sans">
                Hook
              </span>
            </div>
          </div>
          {/* filled save star */}
          <svg
            viewBox="0 0 20 20"
            className="h-4 w-4 shrink-0 fill-[#1C1C1A]/60"
            aria-hidden
          >
            <path d="M10 1.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L10 15l-5.2 2.7 1-5.8L1.5 7.7l5.9-.9z" />
          </svg>
        </div>
        <p className="mt-2 text-[11.5px] leading-snug text-[#1C1C1A] line-clamp-2 font-sans">
          Most people overcomplicate writing on LinkedIn. Here&apos;s the 3-line
          hook I reuse every week.
        </p>
        {/* The Ask-AI action → connects the bookmark to the chat/drafting loop */}
        <div className="mt-auto flex items-center gap-2 pt-2.5">
          <span className="inline-flex items-center gap-1 rounded-full bg-[#1C1C1A] px-2.5 py-1 text-[10px] font-medium text-white font-sans">
            <ClaudeIcon variant="currentColor" className="h-2.5 w-2.5 text-white" />
            Model in my voice
          </span>
          <span className="text-[10px] text-[#8A8A86] font-sans">
            → new draft
          </span>
        </div>
      </div>
    </div>
  );
}

// Voice profile — the learned "how you write" card: a short summary line plus
// a few extracted style traits as chips.
function BentoVoiceVisual() {
  const traits = ["Direct", "Story-led", "Short sentences", "Dry humor", "No jargon"];
  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex-1 rounded-md border border-[#E8E8E6] bg-white p-3.5 shadow-[0px_2px_4px_rgba(28,28,26,0.04)] flex flex-col">
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-full bg-[#1C1C1A] text-[11px] font-semibold text-white">
            You
          </div>
          <div className="min-w-0">
            <div className="text-[12px] font-semibold leading-tight text-[#1C1C1A] font-sans">
              Your voice
            </div>
            <div className="text-[10px] text-[#8A8A86] font-sans">
              learned from 214 of your posts
            </div>
          </div>
          <span className="ml-auto flex items-center gap-1 text-[10px] font-medium text-emerald-700 font-sans">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Active
          </span>
        </div>
        <p className="mt-3 text-[12.5px] leading-snug text-[#1C1C1A]">
          &ldquo;You open with a sharp claim, tell one concrete story, then land
          a single takeaway — no fluff, no corporate speak.&rdquo;
        </p>
        <div className="mt-auto flex flex-wrap gap-1.5 pt-3">
          {traits.map((t) => (
            <span
              key={t}
              className="rounded-full bg-[#F0F0EF] px-2 py-0.5 text-[10px] font-medium text-[#5C5C58] font-sans"
            >
              {t}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// Creator styles — a tracked creator's extracted writing-style profile as
// chips, mirroring BentoVoiceVisual's pattern but for someone else's voice,
// with an "Apply to draft" action that connects it into the drafting loop.
function BentoCreatorStyleVisual() {
  const traits = ["Punchy hooks", "Short paragraphs", "Story-first"];
  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex-1 rounded-md border border-[#E8E8E6] bg-white p-3.5 shadow-[0px_2px_4px_rgba(28,28,26,0.04)] flex flex-col">
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-full bg-rose-100 text-[11px] font-semibold text-rose-700">
            SB
          </div>
          <div className="min-w-0">
            <div className="text-[12px] font-semibold leading-tight text-[#1C1C1A] font-sans">
              Sahil Bloom
            </div>
            <div className="text-[10px] text-[#8A8A86] font-sans">
              style extracted from 86 posts
            </div>
          </div>
          <Fingerprint className="ml-auto h-3.5 w-3.5 shrink-0 text-[#8A8A86]" aria-hidden />
        </div>
        <p className="mt-3 text-[12.5px] leading-snug text-[#1C1C1A]">
          &ldquo;Opens with a one-line claim, breaks the body into short story
          beats, closes with a reflective question.&rdquo;
        </p>
        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-3">
          {traits.map((t) => (
            <span
              key={t}
              className="rounded-full bg-[#F0F0EF] px-2 py-0.5 text-[10px] font-medium text-[#5C5C58] font-sans"
            >
              {t}
            </span>
          ))}
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-[#1C1C1A] px-2.5 py-1 text-[10px] font-medium text-white font-sans">
            Apply to draft
          </span>
        </div>
      </div>
    </div>
  );
}

// Custom skills — a short list of saved slash-command skills, each with an
// instruction preview, mirroring the app's real /dashboard/skills library.
function BentoSkillsVisual() {
  const skills = [
    { name: "/cold-outreach", preview: "Write a direct, no-fluff outbound-style hook…" },
    { name: "/thought-leader", preview: "Take a contrarian stance, back it with one story…" },
  ];
  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex-1 rounded-md border border-[#E8E8E6] bg-white p-3.5 shadow-[0px_2px_4px_rgba(28,28,26,0.04)] flex flex-col">
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#1C1C1A]">
            <Zap className="h-3.5 w-3.5 text-white" aria-hidden />
          </div>
          <div className="min-w-0">
            <div className="text-[12px] font-semibold leading-tight text-[#1C1C1A] font-sans">
              Your skills
            </div>
            <div className="text-[10px] text-[#8A8A86] font-sans">
              trigger with / or ⚡ in any chat
            </div>
          </div>
        </div>
        <div className="mt-3 flex flex-1 flex-col gap-2">
          {skills.map((s) => (
            <div
              key={s.name}
              className="rounded-md border border-[#F0F0EF] bg-[#F4F4F3] px-2.5 py-2"
            >
              <div className="font-mono text-[10.5px] font-semibold text-[#1C1C1A]">
                {s.name}
              </div>
              <div className="mt-0.5 text-[10.5px] leading-snug text-[#5C5C58] line-clamp-1 font-sans">
                {s.preview}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Lead magnets — a markdown resource card, mirroring the swipe/bookmark card
// chrome, with a title and an "attached to post" indicator that ties it into
// the drafting loop.
function BentoLeadMagnetVisual() {
  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex-1 rounded-md border border-[#E8E8E6] bg-white p-3.5 shadow-[0px_2px_4px_rgba(28,28,26,0.04)] flex flex-col">
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#F0F0EF]">
            <FileText className="h-3.5 w-3.5 text-[#1C1C1A]" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-semibold leading-tight text-[#1C1C1A] font-sans">
              5 LinkedIn Hooks That Convert
            </div>
            <div className="text-[10px] text-[#8A8A86] font-sans">
              markdown resource · shareable link
            </div>
          </div>
        </div>
        <div className="mt-3 space-y-2">
          <div className="h-2 w-full rounded-full bg-[#F0F0EF]" />
          <div className="h-2 w-5/6 rounded-full bg-[#F0F0EF]" />
          <div className="h-2 w-3/4 rounded-full bg-[#F0F0EF]" />
        </div>
        <div className="mt-auto flex items-center gap-2 pt-3">
          <span className="inline-flex items-center gap-1 rounded-full bg-[#F0F0EF] px-2.5 py-1 text-[10px] font-medium text-[#5C5C58] font-sans">
            <Gift className="h-2.5 w-2.5" aria-hidden />
            Attached to post
          </span>
        </div>
      </div>
    </div>
  );
}

// Weekly batch generation — a Mon–Fri strip with a draft-ready indicator per
// day, plus the one-click summary affordance surfaced from Cowork/dashboard.
function BentoWeeklyBatchVisual() {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex-1 rounded-md border border-[#E8E8E6] bg-white p-3.5 shadow-[0px_2px_4px_rgba(28,28,26,0.04)] flex flex-col">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CalendarCheck className="h-3.5 w-3.5 text-[#1C1C1A]" aria-hidden />
            <span className="text-[12px] font-semibold leading-tight text-[#1C1C1A] font-sans">
              This week&apos;s batch
            </span>
          </div>
          <span className="text-[10px] text-[#8A8A86] font-sans">5 drafts ready</span>
        </div>
        <div className="mt-3 grid grid-cols-5 gap-1.5">
          {days.map((d) => (
            <div
              key={d}
              className="flex flex-col items-center gap-1.5 rounded border border-[#F0F0EF] bg-[#F4F4F3] py-2"
            >
              <span className="text-[9px] uppercase tracking-[0.08em] text-[#8A8A86] font-sans">
                {d}
              </span>
              <span className="grid h-4 w-4 place-items-center rounded-full bg-emerald-500/15 text-emerald-700">
                <Check className="h-2.5 w-2.5" aria-hidden />
              </span>
            </div>
          ))}
        </div>
        <div className="mt-auto flex items-center gap-2 pt-3">
          <span className="inline-flex items-center gap-1 rounded-full bg-[#1C1C1A] px-2.5 py-1 text-[10px] font-medium text-white font-sans">
            <Sparkles className="h-2.5 w-2.5" aria-hidden />
            Generate this week&apos;s batch
          </span>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── PRICING ─────────────────────────── */

function PricingSection() {
  const features = [
    "AI drafting in your voice",
    "Content calendar + scheduling",
    "Track up to 100 creators",
    "Daily-scraped viral feed",
    "LinkedIn publishing connection",
    "Claude MCP connector",
    "Brand-recolored graphics",
    "Unlimited swipe file access",
    "Priority email support",
  ];
  return (
    <section id="pricing" className="w-full border-b border-[rgba(28,28,26,0.12)] px-4 py-16 sm:px-6 md:px-8 md:py-24 lg:px-0">
      <div className="mx-auto mb-12 max-w-[560px] text-center">
        <h2 className="text-3xl font-semibold tracking-tight text-[#1C1C1A] sm:text-4xl">
          One plan. Everything included.
        </h2>
        <p className="mx-auto mt-4 max-w-[44ch] text-base leading-relaxed text-[#5C5C58]">
          No tiers, no add-ons, no surprise upsells. Start with a 7-day free
          trial, cancel anytime.
        </p>
      </div>

      {/* Clean light pricing card — one plan, on-brand paper surface. */}
      <div className="mx-auto max-w-[560px] rounded-2xl border border-[#E8E8E6] bg-[#F0F0EF] p-8 shadow-[0px_1px_2px_rgba(28,28,26,0.05),0px_16px_48px_-16px_rgba(28,28,26,0.15)] sm:p-10">
        <span className="inline-flex items-center rounded-full bg-[#1C1C1A]/10 px-3 py-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-[#1C1C1A]">
          Launch offer
        </span>
        <div className="mt-3 flex items-baseline gap-2.5">
          <span className="text-5xl font-semibold tracking-tight text-[#1C1C1A] sm:text-6xl">
            $79
          </span>
          <span className="text-2xl font-medium text-[#8A8A86] line-through decoration-[#8A8A86]/60">
            $99
          </span>
          <span className="text-base font-medium text-[#8A8A86]">/month</span>
        </div>
        <p className="mt-1.5 text-sm text-[#8A8A86]">
          Launch price, locked in while it lasts. Billed monthly. 7-day free
          trial, cancel anytime.
        </p>

        <Link
          href="/sign-up"
          className="mt-7 flex h-12 items-center justify-center rounded-full bg-[#1C1C1A] text-[15px] font-medium text-white shadow-sm transition-colors hover:bg-black"
        >
          Start for free
        </Link>

        <div className="my-7 h-px bg-[#E8E8E6]" />

        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {features.map((f) => (
            <li key={f} className="flex items-center gap-2.5">
              <Check className="h-4 w-4 shrink-0 text-[#1C1C1A]" />
              <span className="text-sm text-[rgba(28,28,26,0.85)]">{f}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ─────────────────────────── FAQ ─────────────────────────── */

function FAQSection() {
  return (
    <section id="faq" className="w-full border-b border-[rgba(28,28,26,0.12)] px-4 py-16 sm:px-6 md:px-8 md:py-24 lg:px-0">
      <div className="mx-auto max-w-[760px]">
        <div className="mb-10 text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-[#1C1C1A] sm:text-4xl">
            Questions, answered.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-[#5C5C58]">
            Still wondering? Email{" "}
            <span className="font-medium text-[#1C1C1A]">hello@swipefile.app</span>{" "}
            and we&apos;ll respond within a day.
          </p>
        </div>

        <div className="divide-y divide-[rgba(28,28,26,0.1)] border-y border-[rgba(28,28,26,0.1)]">
          {FAQS.map((qa) => (
            <details key={qa.q} className="group py-5">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-base font-medium text-[#1C1C1A]">
                {qa.q}
                <span className="shrink-0 text-xl font-light leading-none text-[#8A8A86] transition-transform group-open:rotate-45">
                  +
                </span>
              </summary>
              <p className="mt-3 max-w-prose text-sm leading-relaxed text-[#5C5C58] md:text-base">
                {qa.a}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

const FAQS = [
  {
    q: "What can the AI actually do?",
    a: "Ask it in plain language: draft a post on a topic, rewrite a viral post in your voice, give you 5 hooks to pick from, tighten a draft, or model the structure of a post that's working. It reads your voice profile first, so drafts sound like you — not generic AI. Everything it produces lands as an editable draft you can refine, plan, or schedule.",
  },
  {
    q: "Does it post to LinkedIn for me?",
    a: "Yes, if you connect your LinkedIn account in Settings. You can still use SwipeIn as a planning calendar and copy posts manually, but connected workspaces can schedule approved drafts to publish through the app.",
  },
  {
    q: "What's the Claude MCP connector?",
    a: "MCP (Model Context Protocol) is how Claude securely talks to external tools. We give you a one-click connector for claude.ai — so alongside the built-in chat, you can also use your swipe file straight from Claude. Ask 'find the top 5 AI posts from this week and rewrite the best one in my voice' and it answers using your actual data.",
  },
  {
    q: "Do I have to connect Claude to get value from this?",
    a: "No. The built-in chat, posts pipeline, calendar, LinkedIn scheduling, swipe file, and brand-recolored graphics all work on their own in the SwipeIn dashboard. The claude.ai MCP connector is an optional extra way in if you already live in Claude. Most people just use the dashboard.",
  },
  {
    q: "Who is this for?",
    a: "Anyone shipping content on LinkedIn: ghostwriters, founders building a personal brand, in-house marketers, agencies, sales teams. If you write LinkedIn posts (or pay someone to), this saves you the daily scrolling tax.",
  },
  {
    q: "How do you actually get the LinkedIn posts?",
    a: "A public-data scraping pipeline (via Apify) pulls public posts daily from the profiles you choose. You add up to 100 creators or competitors per workspace.",
  },
  {
    q: "What does 'brand-recolored graphics' mean?",
    a: "When a viral post includes a graphic, we generate a version recolored to match your (or your client's) brand palette, so you can repurpose proven visuals without manually editing them in Figma.",
  },
  {
    q: "Is there a free plan?",
    a: "There's a 7-day free trial with full access, no credit card required. After that it's our launch price of $79/month (normally $99), billed monthly. Cancel anytime.",
  },
  {
    q: "Can I add more than 100 creators?",
    a: "100 is the cap on the Pro plan. If you need more (large agency use cases), email us and we'll work something out.",
  },
];

/* ─────────────────────────── CTA ─────────────────────────── */

function CTASection() {
  // Calm closing CTA on the paper surface — clean and product-confident, not a
  // heavy dark band.
  return (
    <section className="w-full px-4 py-20 sm:px-6 md:px-8 md:py-28 lg:px-0">
      <div className="mx-auto flex max-w-[640px] flex-col items-center gap-6 text-center">
        <h2 className="max-w-[18ch] text-3xl font-semibold tracking-tight text-[#1C1C1A] sm:text-4xl lg:text-5xl">
          Your next post is already half-written.
        </h2>
        <p className="max-w-[46ch] text-base leading-relaxed text-[#5C5C58]">
          Research, draft, and schedule your LinkedIn content in one place. Join the
          creators, founders, and agencies who stopped scrolling and started
          shipping.
        </p>
        <div className="mt-2 flex flex-col items-center gap-3">
          <PrimaryPill href="/sign-up" label="Start for free" />
          <p className="text-[13px] text-[#8A8A86]">
            7 days free. No credit card. Cancel anytime.
          </p>
        </div>
      </div>
    </section>
  );
}
