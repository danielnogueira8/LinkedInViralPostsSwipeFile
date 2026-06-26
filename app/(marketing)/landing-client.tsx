"use client";

import type React from "react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
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

/* Icons (inline SVG) */
const I = {
  // Accent check on the dark pricing specimen. A lightened tint of the brand
  // burnt-orange (#bc4527) so it stays in-brand AND clears WCAG contrast on the
  // dark #37322F surface (the base accent is only ~2.4:1 there; this is ~4.3:1).
  checkOrange: (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path
        d="M10 3L4.5 8.5L2 6"
        stroke="#e07a4f"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
};

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
            <Hero stats={stats} />

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

function Hero({ stats }: { stats: LandingStats }) {
  // The "edition dateline" — the freshness promise turned into a brand ornament,
  // driven by the real daily scrape count. Press-log voice (mono, uppercase).
  const dateline = `ED. 01 · PULLED 06:00 UTC · ${formatStatCount(
    stats.postsPulledToday,
  )} POSTS`;

  return (
    <div className="w-full px-4 pb-12 pt-20 sm:px-6 md:px-8 md:pt-28 lg:px-0 lg:pt-[120px]">
      {/* Asymmetric split: text rail (cols 1-5) + live demo (cols 6-12). Stacks
          on mobile. The text rail is flush-left to the frame's left rule so the
          asymmetry reads as authored, not broken. */}
      <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-12 lg:gap-8">
        {/* Left rail */}
        <div className="relative z-10 flex flex-col items-start gap-5 lg:col-span-5 lg:pr-4">
          <RevealUp>
            <div className="ed-mono inline-flex items-center gap-2 text-[11px] text-[#bc4527]">
              <ClaudeIcon variant="brand" className="h-3.5 w-3.5" />
              LinkedIn swipe file / inside Claude
            </div>
          </RevealUp>
          <RevealUp delay={0.05}>
            <h1 className="ed-display max-w-[12ch] text-[40px] font-semibold leading-[0.98] text-black sm:text-[52px] lg:text-[64px]">
              Ask Claude for your next viral post.
            </h1>
          </RevealUp>
          <RevealUp delay={0.1}>
            <p className="max-w-[42ch] font-sans text-base leading-relaxed text-[#605A57] sm:text-[17px]">
              We template the top posts from 100 creators each morning, then plug
              them straight into Claude.
            </p>
          </RevealUp>
          <RevealUp delay={0.15}>
            <div className="mt-1 flex flex-wrap items-center gap-x-5 gap-y-3">
              <PrimaryPill href="/sign-up" label="Start for free" />
              <Link
                href="#how"
                className="font-sans text-sm font-medium text-[#37322F] underline decoration-[rgba(55,50,47,0.25)] underline-offset-4 transition-colors hover:decoration-[#bc4527]"
              >
                See how it works
              </Link>
            </div>
          </RevealUp>
        </div>

        {/* Right: the live agent demo, framed as the page centerpiece. */}
        <div className="relative lg:col-span-7">
          {/* Soft brand glow behind the demo (atmosphere, dialed down). */}
          <div
            aria-hidden
            className="pointer-events-none absolute -inset-x-8 -top-10 bottom-0 -z-10"
          >
            <svg viewBox="0 0 800 500" className="h-full w-full opacity-25 mix-blend-multiply">
              <defs>
                <radialGradient id="heroGlow" cx="60%" cy="40%" r="55%">
                  <stop offset="0%" stopColor="#FFB37A" stopOpacity="0.55" />
                  <stop offset="55%" stopColor="#FFD9B8" stopOpacity="0.2" />
                  <stop offset="100%" stopColor="#F7F5F3" stopOpacity="0" />
                </radialGradient>
              </defs>
              <ellipse cx="480" cy="200" rx="380" ry="200" fill="url(#heroGlow)" />
            </svg>
          </div>
          <div className="flex h-[min(560px,64vh)] min-h-[300px] flex-col overflow-hidden rounded-[10px] bg-white shadow-[0px_0px_0px_1px_rgba(0,0,0,0.08)]">
            {/* Edition dateline lives in the demo's top chrome — the press log. */}
            <div className="flex items-center justify-between border-b border-[#E0DEDB] px-3 py-2">
              <span className="ed-mono text-[10px] text-[#847971]">{dateline}</span>
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                <span className="ed-mono text-[10px] text-[#847971]">Live</span>
              </span>
            </div>
            <div className="relative flex flex-1 items-start justify-start overflow-hidden">
              <LiveAgentDemo />
            </div>
          </div>
        </div>
      </div>
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
  // Live counts from lib/landing-stats. formatStatCount keeps small numbers
  // exact ("847") and abbreviates only once they pass 1k — looking like a
  // real, growing number rather than a fluffy "12k" placeholder.
  // Editorial data strip: one hero stat (the day's scrape, accented + oversized)
  // followed by three supporting stats on a rule-divided band. Uneven widths so
  // it reads as a typeset masthead, not a 4-equal grid.
  const hero = {
    label: "Posts pulled this morning",
    value: formatStatCount(stats.postsPulledToday),
  };
  const rest = [
    { label: "Creators tracked", value: formatStatCount(stats.creatorsTracked) },
    { label: "Viral posts archived", value: formatStatCount(stats.viralPostsArchived) },
    { label: "Templates generated", value: formatStatCount(stats.templatesGenerated) },
  ];
  return (
    <section className="w-full border-b border-[rgba(55,50,47,0.12)] px-4 py-14 sm:px-6 md:px-8 md:py-20 lg:px-0">
      <div className="grid grid-cols-1 items-stretch gap-y-8 lg:grid-cols-12 lg:gap-x-8">
        {/* Hero stat — the freshness proof, oversized + accented. */}
        <div className="lg:col-span-5">
          <div className="ed-mono text-[11px] text-[#847971]">{hero.label}</div>
          <div className="ed-display mt-2 text-6xl leading-none text-[#bc4527] sm:text-7xl lg:text-[88px]">
            {hero.value}
          </div>
          <p className="mt-3 max-w-[34ch] font-sans text-sm leading-relaxed text-[#605A57]">
            Scraped overnight from the creators you track, ranked by engagement,
            templated and ready for Claude before you wake up.
          </p>
        </div>

        {/* Supporting stats — rule-divided, mono labels, Bricolage numerals. */}
        <div className="grid grid-cols-1 sm:grid-cols-3 lg:col-span-7 lg:pl-8">
          {rest.map((s, i) => (
            <div
              key={s.label}
              className={`flex flex-col justify-center py-5 sm:px-6 sm:py-0 ${
                i > 0 ? "border-t border-[#E3E2E1] sm:border-l sm:border-t-0" : ""
              }`}
            >
              <div className="ed-display text-4xl leading-none text-black lg:text-5xl">
                {s.value}
              </div>
              <div className="ed-mono mt-2 text-[10px] text-[#847971]">{s.label}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────── BENTO ─────────────────────────── */

function BentoSection() {
  return (
    <section id="how" className="w-full border-b border-[rgba(55,50,47,0.12)] px-4 py-16 sm:px-6 md:px-8 md:py-24 lg:px-0">
      {/* Left-aligned section header (no centered stack, no eyebrow overcount). */}
      <div className="mb-10 max-w-[640px]">
        <div className="ed-mono mb-3 text-[11px] text-[#bc4527]">What&apos;s inside</div>
        <h2 className="ed-display text-3xl leading-[1.05] text-black sm:text-4xl lg:text-5xl">
          A swipe file Claude can actually use
        </h2>
        <p className="mt-4 max-w-[52ch] font-sans text-base leading-relaxed text-[#605A57]">
          Every post, template, and signal is exposed to Claude via MCP. Stop
          hunting through spreadsheets. Just ask the agent what works.
        </p>
      </div>

      {/* Mosaic: MCP is the tall lead cell (cols 1-7); the other three are
          supporting cells (cols 8-12), stacked. No 2x2 grid. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 lg:gap-5">
        <BentoCell
          className="lg:col-span-7 lg:row-span-2"
          title="Claude MCP: talk to your swipe file"
          blurb="One-click connector for claude.ai. Ask Claude what's working, add accounts, and generate a draft, all without leaving chat."
          tall
        >
          <BentoMCPVisual />
        </BentoCell>
        <BentoCell
          className="lg:col-span-5"
          title="Daily-scraped viral feed"
          blurb="Every morning at 06:00 UTC. Filter by niche, date, or virality threshold, or let the agent do it."
        >
          <BentoSwipeVisual />
        </BentoCell>
        <BentoCell
          className="lg:col-span-5"
          title="Agent-ready templates"
          blurb="Every viral post turned into a structured template Claude fills with your voice, offer, and story."
        >
          <BentoTemplateVisual />
        </BentoCell>
        <BentoCell
          className="lg:col-span-7"
          title="Lead-magnet detection"
          blurb="We tag the ‘comment PLAYBOOK’ posts pulling 2k+ DMs so you and Claude can reverse-engineer the offer."
        >
          <BentoLeadMagnetVisual />
        </BentoCell>
      </div>
    </section>
  );
}

function BentoCell({
  className = "",
  title,
  blurb,
  tall = false,
  children,
}: {
  className?: string;
  title: string;
  blurb: string;
  tall?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`group flex flex-col gap-5 rounded-xl border border-[#E0DEDB] bg-[#FBFAF9] p-6 transition-colors hover:border-[rgba(55,50,47,0.25)] sm:p-7 ${className}`}
    >
      <div className="flex flex-col gap-2">
        <h3 className="ed-display text-xl leading-tight text-black">{title}</h3>
        <p className="font-sans text-sm leading-relaxed text-[#605A57]">{blurb}</p>
      </div>
      <div
        className={`relative flex w-full flex-1 items-center justify-center overflow-hidden rounded-lg ${
          tall ? "min-h-[280px]" : "min-h-[200px]"
        }`}
      >
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

function BentoTemplateVisual() {
  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex-1 bg-white border border-[#E0DEDB] rounded-md p-4 shadow-[0px_2px_4px_rgba(50,45,43,0.04)] flex flex-col gap-2">
        <div className="text-black font-serif text-lg md:text-xl leading-tight">
          The{" "}
          <span className="bg-[#FFF3E8] px-1 rounded-sm">[N]</span>-step
          template I&apos;ve used{" "}
          <span className="bg-[#FFF3E8] px-1 rounded-sm">[X]</span>+ times:
        </div>
        <div className="text-[#605A57] text-sm font-sans space-y-1">
          <div>1. Hook: <span className="bg-[#FFF3E8] px-1 rounded-sm text-black">[bold claim]</span></div>
          <div>2. Story: <span className="bg-[#FFF3E8] px-1 rounded-sm text-black">[your proof]</span></div>
          <div>3. Lesson: <span className="bg-[#FFF3E8] px-1 rounded-sm text-black">[takeaway]</span></div>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between text-[10px] text-[#605A57] font-sans uppercase tracking-[0.14em] px-1">
        <span>From Justin Welsh · 8.9k ♥</span>
        <span className="text-black">Copy ⌘C</span>
      </div>
    </div>
  );
}

function BentoLeadMagnetVisual() {
  return (
    <div className="w-full h-full flex flex-col gap-2">
      <div className="flex-1 bg-white border border-[#E0DEDB] rounded-md p-3.5 shadow-[0px_2px_4px_rgba(50,45,43,0.04)]">
        <div className="flex items-center gap-2">
          <div className="grid h-7 w-7 place-items-center rounded-full bg-violet-100 text-violet-700 text-[10px] font-semibold">
            HK
          </div>
          <div className="text-[12px] text-black font-semibold font-sans">
            Hatice Kamran
          </div>
          <div className="ml-auto px-2 py-0.5 bg-[#FFF3E8] text-[#9A4F00] text-[9px] font-medium rounded-full uppercase tracking-[0.1em] font-sans">
            Lead Magnet
          </div>
        </div>
        <p className="mt-3 text-black font-serif text-base leading-snug">
          Comment <span className="font-semibold">&ldquo;PLAYBOOK&rdquo;</span>{" "}
          and I&apos;ll DM you the 47-page guide free.
        </p>
        <div className="mt-3 flex items-center justify-between rounded bg-[#F7F5F3] px-2.5 py-1.5">
          <span className="text-[10.5px] text-[#605A57] font-sans uppercase tracking-[0.12em]">
            DM intent
          </span>
          <span className="text-black text-[12px] font-semibold font-sans">
            94 / 100
          </span>
        </div>
      </div>
      <div className="text-[10px] text-[#605A57] font-sans uppercase tracking-[0.14em] px-1">
        1.8k DMs triggered · 2 days ago
      </div>
    </div>
  );
}

function BentoMCPVisual() {
  return (
    <div className="w-full h-full bg-[#37322F] rounded-md p-4 shadow-[0px_2px_4px_rgba(50,45,43,0.08)] font-mono text-[11px] md:text-[12px] leading-relaxed text-[#F0EFEE] flex flex-col">
      <div className="flex items-center gap-1.5 text-[10px] text-[#B2AEA9]">
        <ClaudeIcon variant="brand" className="h-3 w-3" />
        claude · swipe-file connected
      </div>
      <div className="mt-3 text-[#FFB37A]">
        &gt; what hooks worked best last week?
      </div>
      <div className="mt-2 text-[#F0EFEE]">Top 3 hook patterns:</div>
      <div className="mt-1 text-[#D2C6BF]">
        1. &ldquo;I made $X from Y…&rdquo;{" "}
        <span className="text-[#FFB37A]">(8 viral)</span>
      </div>
      <div className="text-[#D2C6BF]">
        2. &ldquo;Stop doing X. Do Y…&rdquo;{" "}
        <span className="text-[#FFB37A]">(6 viral)</span>
      </div>
      <div className="text-[#D2C6BF]">
        3. &ldquo;Comment WORD and I&apos;ll DM…&rdquo;{" "}
        <span className="text-[#FFB37A]">(4 viral)</span>
      </div>
    </div>
  );
}

/* ─────────────────────────── PRICING ─────────────────────────── */

function PricingSection() {
  const features = [
    "Track up to 100 creators",
    "Daily-scraped viral feed",
    "Agent-ready post templates",
    "Claude MCP connector",
    "Brand-recolored graphics",
    "Lead-magnet detection",
    "Unlimited swipe file access",
    "Priority email support",
  ];
  return (
    <section id="pricing" className="w-full border-b border-[rgba(55,50,47,0.12)] px-4 py-16 sm:px-6 md:px-8 md:py-24 lg:px-0">
      <div className="mb-10 max-w-[640px]">
        <div className="ed-mono mb-3 text-[11px] text-[#bc4527]">Pricing</div>
        <h2 className="ed-display text-3xl leading-[1.05] text-black sm:text-4xl lg:text-5xl">
          One plan. Everything included.
        </h2>
        <p className="mt-4 max-w-[48ch] font-sans text-base leading-relaxed text-[#605A57]">
          No tiers, no add-ons, no surprise upsells. Start with a 7-day free
          trial, cancel anytime.
        </p>
      </div>

      {/* Single dark specimen — the product chrome treatment ("the agent"),
          a bordered object inside the paper page, not full-bleed. */}
      <div className="mx-auto max-w-[640px] overflow-hidden rounded-2xl bg-[#37322F]">
        <div className="flex flex-col gap-8 p-8 sm:p-10">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="flex items-baseline gap-2">
              <span className="ed-display text-6xl leading-none text-[#FBFAF9] sm:text-7xl">
                $49
              </span>
              <span className="font-sans text-base font-medium text-[#D2C6BF]">
                /month
              </span>
            </div>
            <span className="ed-mono rounded-full bg-[#e07a4f]/15 px-2.5 py-1 text-[10px] text-[#e07a4f]">
              7-day free trial
            </span>
          </div>

          <div className="h-px bg-white/10" />

          <ul className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
            {features.map((f) => (
              <li key={f} className="flex items-center gap-3">
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  {I.checkOrange}
                </span>
                <span className="font-sans text-sm text-[#F0EFEE]">{f}</span>
              </li>
            ))}
          </ul>

          <Link
            href="/sign-up"
            className="relative flex h-12 items-center justify-center overflow-hidden rounded-full bg-[#FBFAF9] shadow-[0px_2px_4px_rgba(0,0,0,0.2)] transition-transform active:scale-[0.99]"
          >
            <span className="font-sans text-[15px] font-medium text-black">
              Start for free
            </span>
          </Link>
          <p className="ed-mono text-center text-[10px] text-[#847971]">
            No credit card required · Cancel anytime
          </p>
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────── FAQ ─────────────────────────── */

function FAQSection() {
  return (
    <section id="faq" className="w-full border-b border-[rgba(55,50,47,0.12)] px-4 py-16 sm:px-6 md:px-8 md:py-24 lg:px-0">
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-12 lg:gap-8">
        {/* Header rail (left), questions (right) — typeset two-column. */}
        <div className="lg:col-span-4">
          <div className="ed-mono mb-3 text-[11px] text-[#bc4527]">FAQ</div>
          <h2 className="ed-display text-3xl leading-[1.05] text-black sm:text-4xl">
            Questions, answered.
          </h2>
          <p className="mt-4 max-w-[34ch] font-sans text-sm leading-relaxed text-[#605A57]">
            Still wondering? Email{" "}
            <span className="font-medium text-black">hello@swipefile.app</span>{" "}
            and we&apos;ll respond within a day.
          </p>
        </div>

        <div className="lg:col-span-8">
          <div className="divide-y divide-[rgba(55,50,47,0.12)] border-t border-[rgba(55,50,47,0.12)]">
            {FAQS.map((qa, i) => (
              <details key={qa.q} className="group py-5">
                <summary className="flex cursor-pointer list-none items-start gap-4">
                  <span className="ed-mono mt-1 shrink-0 text-[11px] text-[#bc4527]">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="ed-display flex-1 text-lg leading-snug text-black decoration-[#bc4527] decoration-2 underline-offset-4 group-open:underline">
                    {qa.q}
                  </span>
                  <span className="mt-1 shrink-0 text-xl font-light leading-none text-[#605A57] transition-transform group-open:rotate-45">
                    +
                  </span>
                </summary>
                <p className="mt-3 max-w-prose pl-9 font-sans text-sm leading-relaxed text-[#605A57] md:text-base">
                  {qa.a}
                </p>
              </details>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

const FAQS = [
  {
    q: "What's the Claude MCP connector?",
    a: "MCP (Model Context Protocol) is how Claude securely talks to external tools. We give you a one-click connector for claude.ai. Once connected, you can ask Claude things like 'find the top 5 AI posts from this week and rewrite the best one in my voice' and it answers using your actual swipe file.",
  },
  {
    q: "Do I have to use Claude to get value from this?",
    a: "No. The dashboard, swipe file, templates, and brand-recolored graphics all work standalone. The Claude MCP just turns the whole thing into an agent, so you ask instead of scroll. Most users use both.",
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
  // The one edge-to-edge dark band — "the Charcoal Thread" close. By now dark has
  // meant "the agent is running" (demo shell, MCP cell, pricing specimen); this
  // full-bleed close lands as "you're inside the product now."
  return (
    <section className="w-full bg-[#37322F] px-4 py-20 sm:px-6 md:px-8 md:py-28 lg:px-0">
      <div className="flex flex-col items-center gap-6 text-center">
        <h2 className="ed-display max-w-[16ch] text-4xl leading-[1.02] text-[#FBFAF9] sm:text-5xl lg:text-[56px]">
          Stop scrolling. Just ask Claude.
        </h2>
        <p className="max-w-[44ch] font-sans text-base leading-relaxed text-[#B2AEA9]">
          Join the creators, founders, and agencies who turned LinkedIn from a
          feed into an agent.
        </p>
        <Link
          href="/sign-up"
          className="mt-2 flex h-12 items-center justify-center rounded-full bg-[#FBFAF9] px-10 font-sans text-[15px] font-medium text-black shadow-[0px_2px_8px_rgba(0,0,0,0.25)] transition-transform active:scale-[0.99]"
        >
          Start for free
        </Link>
        <p className="ed-mono text-[10px] text-[#847971]">
          7 days free · No credit card · Cancel anytime
        </p>
      </div>
    </section>
  );
}
