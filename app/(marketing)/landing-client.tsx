"use client";

import type React from "react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { ClaudeIcon } from "@/components/claude-icon";
import type { LandingStats } from "@/lib/landing-stats";
import { formatStatCount } from "@/lib/landing-stats";

/* ─────────────────────────────────────────────
   Shared atoms — pill Badge, dark pill CTA,
   pale pill ghost CTA, diagonal hatched corner.
   Tokens are inline so this page stays self-contained
   and matches the Brillance template exactly.
   ───────────────────────────────────────────── */

function PrimaryPill({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="h-10 sm:h-11 md:h-12 px-6 sm:px-8 md:px-10 lg:px-12 py-2 sm:py-[6px] relative bg-[#bc4527] shadow-[0px_0px_0px_2.5px_rgba(255,255,255,0.08)_inset] overflow-hidden rounded-full flex justify-center items-center cursor-pointer hover:bg-[#a13a20] transition-colors"
    >
      <span className="flex flex-col justify-center text-white text-sm sm:text-base md:text-[15px] font-medium leading-5 font-sans">
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
    <div className="w-full min-h-screen relative bg-[#F7F5F3] overflow-x-hidden flex flex-col justify-start items-center -mt-16">
      <div className="relative flex flex-col justify-start items-center w-full">
        <div className="w-full max-w-none px-4 sm:px-6 md:px-8 lg:px-0 lg:max-w-[1060px] lg:w-[1060px] relative flex flex-col justify-start items-start min-h-screen">
          {/* Left vertical rule */}
          <div className="w-[1px] h-full absolute left-4 sm:left-6 md:left-8 lg:left-0 top-0 bg-[rgba(55,50,47,0.12)] shadow-[1px_0px_0px_white] z-0" />
          {/* Right vertical rule */}
          <div className="w-[1px] h-full absolute right-4 sm:right-6 md:right-8 lg:right-0 top-0 bg-[rgba(55,50,47,0.12)] shadow-[1px_0px_0px_white] z-0" />

          <div className="self-stretch pt-[9px] overflow-hidden border-b border-[rgba(55,50,47,0.06)] flex flex-col justify-center items-center gap-4 sm:gap-6 md:gap-8 lg:gap-[66px] relative z-10">
            {/* Hero */}
            <Hero />

            {/* Numbers */}
            <NumbersSection stats={stats} />

            {/* Bento */}
            <BentoSection />

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
    <div className="w-full px-4 pb-10 pt-20 sm:px-6 md:px-8 md:pt-24 lg:px-0 lg:pt-[112px]">
      {/* Clean, centered product hero: a quiet pill eyebrow, a confident Geist
          headline, one line of subtext, two CTAs, then the live demo as a
          full-width centerpiece directly below. */}
      <div className="mx-auto flex max-w-[760px] flex-col items-center text-center">
        <RevealUp>
          <Link
            href="#features"
            className="inline-flex items-center gap-2 rounded-full border border-[rgba(55,50,47,0.12)] bg-white px-3 py-1.5 text-[13px] font-medium text-[#37322F] shadow-sm transition-colors hover:bg-[#FBFAF9]"
          >
            <ClaudeIcon variant="brand" className="h-3.5 w-3.5" />
            Research → draft → plan, in one place
          </Link>
        </RevealUp>
        <RevealUp delay={0.05}>
          <h1 className="mt-6 text-[34px] font-semibold leading-[1.05] tracking-tight text-black sm:text-5xl lg:text-[58px]">
            From blank page to booked calendar.
          </h1>
        </RevealUp>
        <RevealUp delay={0.1}>
          <p className="mt-5 max-w-[52ch] text-base leading-relaxed text-[#605A57] sm:text-lg">
            SwipeIn tracks what&apos;s working on LinkedIn, drafts your next post
            in your voice, and lays it out on a calendar you can actually keep.
            Stop scrolling for ideas — start shipping.
          </p>
        </RevealUp>
        <RevealUp delay={0.15}>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <PrimaryPill href="/sign-up" label="Start for free" />
            <Link
              href="#pricing"
              className="flex h-12 items-center justify-center rounded-full border border-[rgba(55,50,47,0.14)] bg-white px-7 text-[15px] font-medium text-[#37322F] shadow-sm transition-colors hover:bg-[#FBFAF9]"
            >
              See pricing
            </Link>
          </div>
        </RevealUp>
        <RevealUp delay={0.2}>
          <p className="mt-4 text-[13px] text-[#847971]">
            7-day free trial. No credit card required.
          </p>
        </RevealUp>
      </div>

      {/* Live agent demo — the centerpiece, full width under the hero copy. */}
      <RevealUp delay={0.25} className="mx-auto mt-12 w-full max-w-[960px]">
        <div className="relative">
          <div
            aria-hidden
            className="pointer-events-none absolute -inset-x-6 -top-8 bottom-0 -z-10"
          >
            <svg viewBox="0 0 800 400" className="h-full w-full opacity-30 mix-blend-multiply">
              <defs>
                <radialGradient id="heroGlow" cx="50%" cy="35%" r="55%">
                  <stop offset="0%" stopColor="#FFB37A" stopOpacity="0.5" />
                  <stop offset="55%" stopColor="#FFD9B8" stopOpacity="0.18" />
                  <stop offset="100%" stopColor="#F7F5F3" stopOpacity="0" />
                </radialGradient>
              </defs>
              <ellipse cx="400" cy="180" rx="380" ry="180" fill="url(#heroGlow)" />
            </svg>
          </div>
          <div className="h-[300px] overflow-hidden rounded-xl bg-white shadow-[0px_1px_2px_rgba(55,50,47,0.06),0px_12px_40px_-12px_rgba(55,50,47,0.18)] ring-1 ring-[rgba(55,50,47,0.08)] sm:h-[420px] md:h-[520px]">
            <LiveAgentDemo />
          </div>
        </div>
      </RevealUp>
    </div>
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

   Palette + chrome match BentoMCPVisual exactly (#37322F shell, #FFB37A
   prompt, #D2C6BF body, green check) so it reads as part of the template,
   not a bolted-on widget.
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

Who are you actually writing for? 👇`;

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
    <div className="w-full h-full bg-[#37322F] flex flex-col overflow-hidden">
      {/* Connection bar — mirrors BentoMCPVisual's header */}
      <div className="flex items-center gap-2 px-4 sm:px-5 py-2.5 sm:py-3 border-b border-white/[0.07] shrink-0">
        <ClaudeIcon variant="brand" className="h-3.5 w-3.5" />
        <span className="font-mono text-[10px] sm:text-[11px] text-[#B2AEA9]">
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
        <div className="font-mono text-[12px] sm:text-[13px] md:text-[15px] text-[#FFB37A] leading-relaxed">
          <span className="text-[#847971]">&gt; </span>
          {typedPrompt}
          {caretOnPrompt && (
            <span className="inline-block w-[7px] -mb-0.5 h-[1.05em] bg-[#FFB37A]/70 animate-pulse" />
          )}
        </div>

        {/* Narrated activity stream */}
        {stepsShown > 0 && (
          <div className="flex flex-col gap-1.5 sm:gap-2 border-l-2 border-white/10 pl-3 sm:pl-3.5">
            {DEMO_STEPS.slice(0, stepsShown).map((s) => (
              <div
                key={s.label}
                className="flex items-center gap-2 font-mono text-[11px] sm:text-[12px] md:text-[13px] text-[#D2C6BF] agent-step-in"
              >
                <CheckGlyph />
                <span>
                  {s.label}
                  {s.detail && (
                    <span className="text-[#847971]"> · {s.detail}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Streaming draft card. Mirrors the in-app draft card: soft white
            surface, rounded, subtle border + shadow lifting it off the dark
            panel. mt-2/3 separates it from the activity steps above. */}
        {draftStarted && (
          <div className="mt-2 sm:mt-3 rounded-xl border border-black/5 bg-[#FBFAF9] p-3.5 sm:p-5 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.45)] agent-step-in">
            <div className="flex items-center gap-2 mb-2 sm:mb-2.5">
              <div className="h-5 w-5 sm:h-6 sm:w-6 rounded-full bg-[#E0DEDB] shrink-0" />
              <span className="font-sans text-[10px] sm:text-[11px] font-semibold text-black">
                Your draft
              </span>
              <span className="ml-auto px-2 py-0.5 rounded-full bg-[#F1EFE8] text-[#847971] text-[8px] sm:text-[9px] font-medium uppercase tracking-[0.12em] font-sans">
                Draft
              </span>
            </div>
            <div className="font-sans text-[11px] sm:text-[12.5px] md:text-[13.5px] leading-relaxed text-black whitespace-pre-wrap">
              {draftText}
              {caretOnDraft && (
                <span className="inline-block w-[6px] -mb-0.5 h-[1.05em] bg-[#37322F]/40 animate-pulse" />
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
    <section className="w-full border-b border-[rgba(55,50,47,0.12)] px-4 py-12 sm:px-6 md:px-8 md:py-16 lg:px-0">
      <div className="grid grid-cols-2 gap-y-8 lg:grid-cols-4">
        {display.map((s, i) => (
          <div
            key={s.label}
            className={`flex flex-col items-center px-2 text-center lg:items-start lg:text-left ${
              i > 0 ? "lg:border-l lg:border-[rgba(55,50,47,0.1)] lg:pl-6" : ""
            }`}
          >
            <div className="text-4xl font-semibold tracking-tight text-black tabular-nums lg:text-5xl">
              {s.value}
            </div>
            <div className="mt-2 text-[13px] text-[#605A57]">{s.label}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ─────────────────────────── BENTO ─────────────────────────── */

function BentoSection() {
  return (
    <section id="features" className="w-full border-b border-[rgba(55,50,47,0.12)] px-4 py-16 sm:px-6 md:px-8 md:py-24 lg:px-0">
      {/* Centered product section header. */}
      <div className="mx-auto mb-12 max-w-[620px] text-center">
        <h2 className="text-3xl font-semibold tracking-tight text-black sm:text-4xl">
          Everything from idea to posted.
        </h2>
        <p className="mx-auto mt-4 max-w-[52ch] text-base leading-relaxed text-[#605A57]">
          Research, drafting, and planning in one place — not five tabs and a
          spreadsheet.
        </p>
      </div>

      {/* Balanced 2-col feature grid. Each cell carries a real visual, so the
          grid has genuine background variation (not flat text cards). */}
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <BentoCell
          title="AI that writes in your voice"
          blurb="Ask for a post; the agent studies your voice profile and what's working in your niche, then drafts it — ready to refine or ship."
        >
          <BentoChatVisual />
        </BentoCell>
        <BentoCell
          title="Your content calendar"
          blurb="Every draft lands on a calendar you can actually keep. Plan the week, see what's due, copy a post out in one click when it's time."
        >
          <BentoCalendarVisual />
        </BentoCell>
        <BentoCell
          title="A pipeline, idea to posted"
          blurb="Drag a card from idea to drafting to ready to posted. Your whole content backlog in one board, not scattered across notes."
        >
          <BentoPipelineVisual />
        </BentoCell>
        <BentoCell
          title="Daily viral swipe file"
          blurb="Fresh every morning: the top posts from 100 creators you pick. Filter by niche, date, or virality — or let the agent surface them."
        >
          <BentoSwipeVisual />
        </BentoCell>
      </div>
    </section>
  );
}

function BentoCell({
  title,
  blurb,
  children,
}: {
  title: string;
  blurb: string;
  children: React.ReactNode;
}) {
  return (
    <div className="group flex flex-col gap-5 rounded-xl border border-[#E0DEDB] bg-[#FBFAF9] p-6 shadow-sm transition-all hover:-translate-y-0.5 hover:border-[rgba(55,50,47,0.2)] hover:shadow-md sm:p-7">
      <div className="flex flex-col gap-2">
        <h3 className="text-lg font-semibold tracking-tight text-black">{title}</h3>
        <p className="text-sm leading-relaxed text-[#605A57]">{blurb}</p>
      </div>
      <div className="relative flex min-h-[200px] w-full flex-1 items-center justify-center overflow-hidden rounded-lg">
        {children}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-[#FBFAF9] to-transparent" />
      </div>
    </div>
  );
}

/* Bento visuals — all in HTML/SVG, no external assets */

function BentoSwipeVisual() {
  const posts = [
    {
      author: "Lara Acosta",
      tint: "bg-rose-100 text-rose-700",
      initials: "LA",
      preview: "I made $2M from LinkedIn in 2 years…",
      reactions: "12.4k",
    },
    {
      author: "Justin Welsh",
      tint: "bg-emerald-100 text-emerald-700",
      initials: "JW",
      preview: "Most people overcomplicate writing on LinkedIn.",
      reactions: "8.9k",
    },
    {
      author: "Hatice Kamran",
      tint: "bg-violet-100 text-violet-700",
      initials: "HK",
      preview: "Comment PLAYBOOK and I'll DM you the full guide…",
      reactions: "5.2k",
    },
  ];
  return (
    <div className="w-full h-full flex flex-col gap-2 pt-1">
      {posts.map((p, i) => (
        <div
          key={p.author}
          className={`flex items-start gap-3 bg-white border border-[#E0DEDB] rounded-md px-3.5 py-2.5 shadow-[0px_2px_4px_rgba(50,45,43,0.04)] ${
            i === 1 ? "md:translate-x-2" : ""
          }`}
        >
          <div
            className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-[10px] font-semibold ${p.tint}`}
          >
            {p.initials}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-black text-[12.5px] font-semibold leading-tight font-sans">
              {p.author}
            </div>
            <div className="mt-1 text-[#605A57] text-[11.5px] line-clamp-1 font-sans">
              {p.preview}
            </div>
          </div>
          <div className="text-black text-[11px] font-medium font-sans tabular-nums">
            ♥ {p.reactions}
          </div>
        </div>
      ))}
    </div>
  );
}

// The agent drafting in your voice — the product's dark shell (matches the
// hero LiveAgentDemo + old MCP visual chrome), reframed around the CHAT feature:
// you ask, it studies your voice, a post streams back.
function BentoChatVisual() {
  return (
    <div className="w-full h-full bg-[#37322F] rounded-md p-4 shadow-[0px_2px_4px_rgba(50,45,43,0.08)] font-mono text-[11px] md:text-[12px] leading-relaxed text-[#F0EFEE] flex flex-col">
      <div className="flex items-center gap-1.5 text-[10px] text-[#B2AEA9]">
        <ClaudeIcon variant="brand" className="h-3 w-3" />
        swipein · chat
      </div>
      <div className="mt-3 text-[#FFB37A]">
        &gt; write me a post about hiring for curiosity
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-[10px] text-[#B2AEA9]">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
        reading your voice profile · matching what&apos;s working
      </div>
      <div className="mt-2.5 rounded bg-[#2B2724] px-2.5 py-2 text-[#EDE7E2] font-sans text-[11px] leading-snug">
        <span className="text-white font-semibold">
          I stopped reading resumes.
        </span>{" "}
        Now I ask one question: &ldquo;What&apos;s the last thing you got
        obsessed with?&rdquo; It tells me more than a decade of…
      </div>
      <div className="mt-2 flex items-center gap-2 text-[10px] text-[#B2AEA9]">
        <span className="rounded-sm bg-[#FFF3E8] px-1.5 py-0.5 text-[#9A4F00]">
          in your voice
        </span>
        <span className="text-[#847971]">draft ready · refine or ship</span>
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
    idea: "bg-[#F1EFE8] text-[#847971]",
    ready: "bg-[#FFF3E8] text-[#9A4F00]",
    posted: "bg-emerald-50 text-emerald-700",
  };
  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex-1 bg-white border border-[#E0DEDB] rounded-md p-3 shadow-[0px_2px_4px_rgba(50,45,43,0.04)] flex flex-col">
        <div className="flex items-center justify-between px-0.5">
          <span className="text-[11px] font-semibold text-black font-sans">
            This week
          </span>
          <span className="text-[10px] text-[#847971] font-sans">March</span>
        </div>
        <div className="mt-2 grid flex-1 grid-cols-5 gap-1.5">
          {days.map((day) => (
            <div
              key={day.d}
              className="flex flex-col rounded border border-[#EFEAE4] bg-[#FCFBF9] p-1.5"
            >
              <div className="text-[9px] uppercase tracking-[0.08em] text-[#847971] font-sans">
                {day.d}
              </div>
              <div className="text-[11px] font-semibold text-black font-sans tabular-nums">
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
      <div className="mt-2 flex items-center gap-3 px-1 text-[10px] text-[#605A57] font-sans">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-[#847971]/50" />
          Idea
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-[#E5A663]" />
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
    { name: "Idea", cards: ["Cold outreach myth"], accent: "text-[#847971]" },
    { name: "Drafting", cards: ["Hiring post"], accent: "text-[#9A4F00]" },
    { name: "Ready", cards: ["Founder story"], accent: "text-[#3E7C59]" },
    { name: "Posted", cards: ["$2M lesson"], accent: "text-[#605A57]" },
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
                className="rounded border border-[#E0DEDB] bg-white px-1.5 py-1.5 text-[9.5px] font-medium leading-tight text-black shadow-[0px_1px_2px_rgba(50,45,43,0.04)] font-sans"
              >
                {c}
              </div>
            ))}
            {/* an empty ghost slot so columns look like a real board */}
            <div className="rounded border border-dashed border-[#E6E1DB] px-1.5 py-1.5" />
          </div>
        ))}
      </div>
      <div className="mt-3 px-1 text-[10px] text-[#605A57] font-sans">
        Drag a card to move it along →
      </div>
    </div>
  );
}

/* ─────────────────────────── PRICING ─────────────────────────── */

function PricingSection() {
  const features = [
    "AI drafting in your voice",
    "Content calendar + pipeline",
    "Track up to 100 creators",
    "Daily-scraped viral feed",
    "Claude MCP connector",
    "Brand-recolored graphics",
    "Unlimited swipe file access",
    "Priority email support",
  ];
  return (
    <section id="pricing" className="w-full border-b border-[rgba(55,50,47,0.12)] px-4 py-16 sm:px-6 md:px-8 md:py-24 lg:px-0">
      <div className="mx-auto mb-12 max-w-[560px] text-center">
        <h2 className="text-3xl font-semibold tracking-tight text-black sm:text-4xl">
          One plan. Everything included.
        </h2>
        <p className="mx-auto mt-4 max-w-[44ch] text-base leading-relaxed text-[#605A57]">
          No tiers, no add-ons, no surprise upsells. Start with a 7-day free
          trial, cancel anytime.
        </p>
      </div>

      {/* Clean light pricing card — one plan, on-brand paper surface. */}
      <div className="mx-auto max-w-[560px] rounded-2xl border border-[#E0DEDB] bg-[#FBFAF9] p-8 shadow-[0px_1px_2px_rgba(55,50,47,0.05),0px_16px_48px_-16px_rgba(55,50,47,0.15)] sm:p-10">
        <div className="flex items-baseline gap-2">
          <span className="text-5xl font-semibold tracking-tight text-black sm:text-6xl">
            $49
          </span>
          <span className="text-base font-medium text-[#847971]">/month</span>
        </div>
        <p className="mt-1.5 text-sm text-[#847971]">
          Billed monthly. 7-day free trial, cancel anytime.
        </p>

        <Link
          href="/sign-up"
          className="mt-7 flex h-12 items-center justify-center rounded-full bg-[#bc4527] text-[15px] font-medium text-white shadow-sm transition-colors hover:bg-[#a13a20]"
        >
          Start for free
        </Link>

        <div className="my-7 h-px bg-[#E0DEDB]" />

        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {features.map((f) => (
            <li key={f} className="flex items-center gap-2.5">
              <Check className="h-4 w-4 shrink-0 text-[#bc4527]" />
              <span className="text-sm text-[rgba(55,50,47,0.85)]">{f}</span>
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
    <section id="faq" className="w-full border-b border-[rgba(55,50,47,0.12)] px-4 py-16 sm:px-6 md:px-8 md:py-24 lg:px-0">
      <div className="mx-auto max-w-[760px]">
        <div className="mb-10 text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-black sm:text-4xl">
            Questions, answered.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-[#605A57]">
            Still wondering? Email{" "}
            <span className="font-medium text-black">hello@swipefile.app</span>{" "}
            and we&apos;ll respond within a day.
          </p>
        </div>

        <div className="divide-y divide-[rgba(55,50,47,0.1)] border-y border-[rgba(55,50,47,0.1)]">
          {FAQS.map((qa) => (
            <details key={qa.q} className="group py-5">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-base font-medium text-black">
                {qa.q}
                <span className="shrink-0 text-xl font-light leading-none text-[#847971] transition-transform group-open:rotate-45">
                  +
                </span>
              </summary>
              <p className="mt-3 max-w-prose text-sm leading-relaxed text-[#605A57] md:text-base">
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
    a: "Ask it in plain language: draft a post on a topic, rewrite a viral post in your voice, give you 5 hooks to pick from, tighten a draft, or model the structure of a post that's working. It reads your voice profile first, so drafts sound like you — not generic AI. Everything it produces lands as an editable draft you can refine or send to your calendar.",
  },
  {
    q: "Does it post to LinkedIn for me?",
    a: "Not today. SwipeIn helps you plan — you lay drafts out on a calendar, track them from idea to posted, and copy the finished post out in one click. You publish it from LinkedIn yourself. We don't auto-post on your behalf.",
  },
  {
    q: "What's the Claude MCP connector?",
    a: "MCP (Model Context Protocol) is how Claude securely talks to external tools. We give you a one-click connector for claude.ai — so alongside the built-in chat, you can also use your swipe file straight from Claude. Ask 'find the top 5 AI posts from this week and rewrite the best one in my voice' and it answers using your actual data.",
  },
  {
    q: "Do I have to connect Claude to get value from this?",
    a: "No. The built-in chat, posts pipeline, calendar, swipe file, and brand-recolored graphics all work on their own in the SwipeIn dashboard. The claude.ai MCP connector is an optional extra way in if you already live in Claude. Most people just use the dashboard.",
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
    a: "There's a 7-day free trial with full access, no credit card required. After that it's $49/month, billed monthly. Cancel anytime.",
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
        <h2 className="max-w-[18ch] text-3xl font-semibold tracking-tight text-black sm:text-4xl lg:text-5xl">
          Your next post is already half-written.
        </h2>
        <p className="max-w-[46ch] text-base leading-relaxed text-[#605A57]">
          Research, draft, and plan your LinkedIn content in one place. Join the
          creators, founders, and agencies who stopped scrolling and started
          shipping.
        </p>
        <div className="mt-2 flex flex-col items-center gap-3">
          <PrimaryPill href="/sign-up" label="Start for free" />
          <p className="text-[13px] text-[#847971]">
            7 days free. No credit card. Cancel anytime.
          </p>
        </div>
      </div>
    </section>
  );
}
