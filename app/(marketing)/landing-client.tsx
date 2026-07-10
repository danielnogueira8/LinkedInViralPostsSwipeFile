"use client";

import { useRef } from "react";
import Link from "next/link";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import {
  ArrowUpRight,
  CalendarDays,
  Check,
  ChevronRight,
  Circle,
  Search,
  Sparkles,
} from "lucide-react";
import type { LandingStats } from "@/lib/landing-stats";
import { formatStatCount } from "@/lib/landing-stats";

gsap.registerPlugin(useGSAP, ScrollTrigger);

const creators = ["Lara Acosta", "Justin Welsh", "Sahil Bloom", "Jasmin Alić", "Hatice Kamran"];

const workflow = [
  {
    title: "Start with a signal, not a blank page.",
    body: "SwipeIn watches the creators your audience already reads and surfaces the posts breaking away from their usual performance.",
    visual: "signals",
  },
  {
    title: "Turn the pattern into your point of view.",
    body: "The agent reads your voice profile, borrows the structure—not the words—and gives you a draft worth editing.",
    visual: "draft",
  },
  {
    title: "Move from draft to published without losing momentum.",
    body: "Plan the week, approve the post, and schedule it to LinkedIn from the same workspace.",
    visual: "calendar",
  },
] as const;

const workflowVisuals = {
  signals: SignalVisual,
  draft: ClaudeVisual,
  calendar: CalendarWorkflowVisual,
} as const;

const faqs = [
  ["Does SwipeIn write the whole post?", "Yes. It can find an angle, draft in your voice, revise the copy, and leave the result ready for your approval."],
  ["Can it publish to LinkedIn?", "Yes. Connect LinkedIn in Settings and approved drafts can be scheduled directly. You can also keep the calendar as a planning-only workflow."],
  ["Do I need Claude?", "No. SwipeIn has its own built-in agent. The Claude connector is an optional way to use the same swipe file from claude.ai."],
  ["Where do the posts come from?", "SwipeIn pulls public posts daily from the creators you choose, then ranks them against each creator's normal performance."],
];

function CTA({ href = "/sign-up", children, light = false }: { href?: string; children: React.ReactNode; light?: boolean }) {
  return (
    <Link
      href={href}
      className={`group inline-flex h-12 items-center justify-center gap-2 rounded-full px-6 text-sm font-medium transition-transform duration-300 hover:-translate-y-0.5 ${light ? "bg-white text-[#11110f]" : "bg-[#11110f] text-white"}`}
    >
      {children}
      <ArrowUpRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
    </Link>
  );
}

export default function LandingClient({ stats }: { stats: LandingStats }) {
  const page = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduce) return;

      gsap.from("[data-hero]", { y: 30, opacity: 0, duration: 1, stagger: 0.1, ease: "power3.out" });

      gsap.utils.toArray<HTMLElement>("[data-reveal]").forEach((element) => {
        gsap.from(element, {
          y: 50,
          opacity: 0,
          duration: 0.9,
          ease: "power3.out",
          scrollTrigger: { trigger: element, start: "top 84%", once: true },
        });
      });

      gsap.utils.toArray<HTMLElement>("[data-workflow-card]").forEach((card) => {
        gsap.fromTo(
          card,
          { scale: 0.84, opacity: 0.25 },
          {
            scale: 1,
            opacity: 1,
            ease: "none",
            scrollTrigger: { trigger: card, start: "top 88%", end: "center 55%", scrub: 0.7 },
          },
        );
        gsap.to(card, {
          opacity: 0.3,
          ease: "none",
          scrollTrigger: { trigger: card, start: "bottom 42%", end: "bottom 12%", scrub: 0.7 },
        });
      });

      gsap.utils.toArray<HTMLElement>("[data-scroll-image]").forEach((image) => {
        gsap.fromTo(
          image,
          { scale: 0.8, opacity: 0.3 },
          {
            scale: 1,
            opacity: 1,
            ease: "none",
            scrollTrigger: { trigger: image, start: "top 90%", end: "center 55%", scrub: 0.8 },
          },
        );
        gsap.to(image, {
          opacity: 0.2,
          filter: "brightness(0.45)",
          ease: "none",
          scrollTrigger: { trigger: image, start: "bottom 45%", end: "bottom 12%", scrub: 0.8 },
        });
      });

      const words = gsap.utils.toArray<HTMLElement>("[data-word]");
      gsap.fromTo(
        words,
        { opacity: 0.1 },
        {
          opacity: 1,
          stagger: 0.08,
          ease: "none",
          scrollTrigger: { trigger: "[data-manifesto]", start: "top 75%", end: "bottom 58%", scrub: 0.8 },
        },
      );
    },
    { scope: page },
  );

  return (
    <main ref={page} className="w-full max-w-full overflow-x-hidden bg-[#f2f1ec] text-[#11110f]">
      <section className="relative min-h-[calc(100svh-84px)] overflow-hidden px-5 pb-16 pt-16 sm:px-8 lg:px-12 lg:pb-24 lg:pt-24">
        <div className="pointer-events-none absolute inset-0 opacity-70 [background-image:radial-gradient(circle_at_78%_16%,rgba(212,255,77,0.62),transparent_25%),radial-gradient(circle_at_82%_62%,rgba(215,207,255,0.7),transparent_25%)]" />
        <div className="relative mx-auto grid w-full max-w-[1440px] gap-14 lg:grid-cols-[1.08fr_.92fr] lg:items-end">
          <div className="pb-2 lg:pb-10">
            <p data-hero className="mb-8 max-w-sm text-sm leading-6 text-[#5e5d57]">
              The research and writing system for people who take LinkedIn seriously.
            </p>
            <h1 data-hero className="w-full max-w-6xl text-[clamp(3.4rem,6.2vw,6.2rem)] font-medium leading-[0.88] tracking-[-0.075em]">
              Never start a post from zero again.
            </h1>
            <div data-hero className="mt-9 flex flex-wrap items-center gap-3">
              <CTA>Start writing free</CTA>
              <Link href="#how-it-works" className="inline-flex h-12 items-center gap-2 px-4 text-sm font-medium">
                See how it works <ChevronRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
          <div data-hero className="group relative min-h-[520px] overflow-hidden rounded-[2.25rem] bg-[#171715] p-3 shadow-[0_50px_100px_-50px_rgba(17,17,15,.55)] lg:min-h-[640px]">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(255,255,255,.12),transparent_35%)]" />
            <div className="relative flex h-full min-h-[496px] flex-col rounded-[1.65rem] border border-white/10 bg-[#1e1e1b] p-5 text-white lg:min-h-[616px] lg:p-7">
              <div className="flex items-center justify-between border-b border-white/10 pb-5 text-xs text-white/50">
                <span>SwipeIn workspace</span><span className="flex items-center gap-2"><Circle className="h-2 w-2 fill-[#d4ff4d] text-[#d4ff4d]" /> Agent ready</span>
              </div>
              <div className="my-auto space-y-5">
                <div className="ml-auto max-w-[85%] rounded-3xl rounded-br-md bg-white px-5 py-4 text-sm leading-6 text-[#11110f]">
                  Find a strong post about niching down and turn it into something I would write.
                </div>
                <div className="space-y-3 text-sm text-white/58">
                  <p className="flex items-center gap-2"><Check className="h-4 w-4 text-[#d4ff4d]" /> Searched your swipe file</p>
                  <p className="flex items-center gap-2"><Check className="h-4 w-4 text-[#d4ff4d]" /> Compared breakout patterns</p>
                  <p className="flex items-center gap-2"><Check className="h-4 w-4 text-[#d4ff4d]" /> Applied your voice profile</p>
                </div>
                <div className="overflow-hidden rounded-3xl bg-[#f2f1ec] text-[#11110f] transition-transform duration-700 ease-out group-hover:scale-[1.02]">
                  <div className="border-b border-black/10 px-5 py-4 text-xs text-black/45">Draft ready</div>
                  <p className="p-5 text-lg leading-7">Most founders niche down too late.<br /><br />They wait until their ideas are proven. Their audience is clear. Their positioning feels safe.<br /><br />But clarity is not what lets you niche down. Niching down is how you find clarity.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="border-y border-black/10 bg-[#11110f] py-5 text-white">
        <div className="flex w-max animate-[marquee_28s_linear_infinite] items-center gap-12 whitespace-nowrap pr-12 text-sm text-white/60">
          {[...creators, ...creators].map((name, index) => <span key={`${name}-${index}`} className="flex items-center gap-12"><span>{name}</span><span className="text-[#d4ff4d]">Learn from what works</span></span>)}
        </div>
      </section>

      <section className="px-5 py-32 sm:px-8 md:py-48 lg:px-12">
        <div className="mx-auto max-w-[1440px]">
          <div data-reveal className="mb-16 flex flex-col justify-between gap-8 md:flex-row md:items-end">
            <h2 className="max-w-4xl text-[clamp(2.8rem,5.5vw,6rem)] leading-[0.95] tracking-[-0.06em]">One system for the entire publishing loop.</h2>
            <p className="max-w-sm text-base leading-7 text-[#64635d]">The research, the first draft, and the publishing calendar finally share the same context.</p>
          </div>
          <div className="grid grid-flow-dense grid-cols-1 gap-3 md:grid-cols-12 md:grid-rows-2">
            <FeatureCard className="md:col-span-7" tone="dark" title="Daily signal, without the daily scroll." copy="Track the creators that matter. SwipeIn flags the posts outperforming their baseline, not merely the posts with big numbers."><SignalVisual /></FeatureCard>
            <FeatureCard className="md:col-span-5" tone="lime" title="Your voice stays in the room." copy="A living profile guides phrasing, rhythm, structure, and the things you never want the agent to say."><VoiceVisual /></FeatureCard>
            <FeatureCard className="md:col-span-5" tone="lavender" title="A week you can see." copy="Ideas become drafts. Drafts become scheduled posts. Nothing disappears into another document."><WeekVisual /></FeatureCard>
            <FeatureCard className="md:col-span-7" tone="paper" title="Claude can use it too." copy="Connect your swipe file to Claude and ask for the same research, patterns, and voice from the place you already think."><ClaudeVisual /></FeatureCard>
          </div>
        </div>
      </section>

      <section data-manifesto className="bg-[#d7cfff] px-5 py-32 sm:px-8 md:py-48 lg:px-12">
        <p className="mx-auto max-w-[1280px] text-[clamp(2.5rem,5.4vw,6rem)] font-medium leading-[1.04] tracking-[-0.055em]">
          {"Good content is not a volume problem. It is a context problem.".split(" ").map((word, index) => <span data-word key={`${word}-${index}`} className="mr-[.22em] inline-block">{word}</span>)}
          <span data-word aria-hidden className="mx-[.08em] inline-block h-[.62em] w-[1.45em] rounded-full bg-[url('/dashboard.png')] bg-cover bg-center align-[.02em]" />
          {"SwipeIn keeps the evidence, your voice, and the next action in one place.".split(" ").map((word, index) => <span data-word key={`tail-${word}-${index}`} className="mr-[.22em] inline-block">{word}</span>)}
        </p>
      </section>

      <section className="bg-[#11110f] px-5 py-32 text-white sm:px-8 md:py-48 lg:px-12">
        <div className="mx-auto max-w-[1440px]">
          <div data-reveal className="mb-16 flex flex-col justify-between gap-8 md:flex-row md:items-end">
            <h2 className="max-w-4xl text-[clamp(3rem,5.8vw,6.5rem)] leading-[.9] tracking-[-.065em]">The whole workspace, without the tab parade.</h2>
            <p className="max-w-sm text-base leading-7 text-white/50">Move through the product by intent, while every surface shares the same memory.</p>
          </div>
          <div className="flex min-h-[620px] flex-col gap-2 md:flex-row">
            {[
              ["Research", "See what is breaking out before the feed catches up."],
              ["Write", "Turn proven structure into a draft that still sounds like you."],
              ["Plan", "Give every good idea a visible next action."],
              ["Publish", "Schedule approved work without rebuilding the context."],
            ].map(([title, copy], index) => (
              <article key={title} className="group relative min-h-[180px] flex-1 overflow-hidden rounded-[1.75rem] border border-white/10 transition-[flex] duration-700 ease-out hover:flex-[2.5] md:min-h-0">
                <div data-scroll-image className="absolute inset-0 bg-[url('/dashboard.png')] bg-cover bg-center grayscale contrast-125" style={{ backgroundPosition: `${18 + index * 22}% center` }} />
                <div className="absolute inset-0 bg-gradient-to-t from-black via-black/35 to-black/5" />
                <div className="absolute inset-x-0 bottom-0 p-6 sm:p-8">
                  <h3 className="text-3xl tracking-[-.04em]">{title}</h3>
                  <p className="mt-3 max-w-sm text-sm leading-6 text-white/55 opacity-100 transition-opacity duration-500 md:opacity-0 md:group-hover:opacity-100">{copy}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="how-it-works" className="px-5 py-32 sm:px-8 md:py-48 lg:px-12">
        <div className="mx-auto grid max-w-[1440px] gap-16 lg:grid-cols-[.7fr_1.3fr]">
          <div className="lg:sticky lg:top-32 lg:h-fit">
            <h2 className="max-w-xl text-[clamp(3rem,5vw,5.5rem)] leading-[.94] tracking-[-.06em]">From signal to scheduled.</h2>
            <p className="mt-6 max-w-sm text-base leading-7 text-[#64635d]">A straight line through the work, with the agent carrying context at every step.</p>
          </div>
          <div className="space-y-24 lg:space-y-40">
            {workflow.map((item) => <WorkflowCard key={item.title} {...item} />)}
          </div>
        </div>
      </section>

      <section className="border-y border-black/10 px-5 py-24 sm:px-8 md:py-32 lg:px-12">
        <div data-reveal className="mx-auto grid max-w-[1440px] grid-cols-2 gap-y-12 md:grid-cols-4">
          {([
            { value: stats.postsPulledToday, label: "posts pulled today" },
            { value: stats.creatorsTracked, label: "creators tracked" },
            { value: stats.viralPostsArchived, label: "viral posts archived" },
            { value: stats.templatesGenerated, label: "patterns extracted" },
          ] satisfies { value: number; label: string }[]).map(({ value, label }) => <div key={label} className="border-l border-black/15 pl-5"><p className="text-[clamp(2.4rem,4vw,4.5rem)] tracking-[-.06em]">{formatStatCount(value)}</p><p className="mt-2 text-sm text-[#64635d]">{label}</p></div>)}
        </div>
      </section>

      <section id="pricing" className="bg-[#11110f] px-5 py-32 text-white sm:px-8 md:py-48 lg:px-12">
        <div className="mx-auto grid max-w-[1440px] gap-16 lg:grid-cols-[1fr_.8fr] lg:items-center">
          <div data-reveal>
            <h2 className="max-w-4xl text-[clamp(3.2rem,6vw,7rem)] leading-[.88] tracking-[-.07em]">A serious content system. One simple plan.</h2>
            <p className="mt-8 max-w-lg text-lg leading-8 text-white/55">Everything you need to research, write, plan, and publish. Seven days free, with no credit card.</p>
          </div>
          <div data-reveal className="rounded-[2rem] bg-[#d4ff4d] p-7 text-[#11110f] sm:p-10">
            <p className="text-sm">Launch price</p>
            <div className="mt-3 flex items-end gap-3"><span className="text-7xl tracking-[-.07em]">$79</span><span className="pb-2 text-black/55">/ month</span></div>
            <ul className="my-9 space-y-3 border-y border-black/15 py-8 text-sm">
              {["Daily viral swipe file", "Agent drafting in your voice", "Content calendar and scheduling", "Up to 100 tracked creators", "Claude MCP connector"].map(item => <li key={item} className="flex items-center gap-3"><Check className="h-4 w-4" />{item}</li>)}
            </ul>
            <CTA>Start your free week</CTA>
          </div>
        </div>
      </section>

      <section id="faq" className="px-5 py-32 sm:px-8 md:py-48 lg:px-12">
        <div className="mx-auto grid max-w-[1200px] gap-16 lg:grid-cols-[.65fr_1fr]">
          <h2 data-reveal className="text-[clamp(3rem,5vw,5.5rem)] leading-[.92] tracking-[-.06em]">The useful questions.</h2>
          <div data-reveal className="border-t border-black/15">
            {faqs.map(([question, answer]) => <details key={question} className="group border-b border-black/15 py-6"><summary className="flex cursor-pointer list-none items-center justify-between gap-6 text-lg font-medium">{question}<span className="text-2xl font-light transition-transform group-open:rotate-45">+</span></summary><p className="max-w-2xl pt-4 leading-7 text-[#64635d]">{answer}</p></details>)}
          </div>
        </div>
      </section>

      <section className="px-5 pb-8 sm:px-8 lg:px-12">
        <div data-reveal className="mx-auto flex min-h-[520px] max-w-[1440px] flex-col items-center justify-center overflow-hidden rounded-[2.5rem] bg-[#d7cfff] px-6 py-24 text-center">
          <h2 className="max-w-5xl text-[clamp(3.4rem,7vw,7.5rem)] leading-[.88] tracking-[-.075em]">Your next post already has a starting point.</h2>
          <div className="mt-10"><CTA>Start writing free</CTA></div>
          <p className="mt-5 text-sm text-black/50">Seven days free. No credit card required.</p>
        </div>
      </section>
    </main>
  );
}

function FeatureCard({ title, copy, tone, className, children }: { title: string; copy: string; tone: "dark" | "lime" | "lavender" | "paper"; className?: string; children: React.ReactNode }) {
  const colors = { dark: "bg-[#11110f] text-white", lime: "bg-[#d4ff4d] text-[#11110f]", lavender: "bg-[#d7cfff] text-[#11110f]", paper: "bg-white text-[#11110f]" };
  return <article data-reveal className={`group min-h-[520px] overflow-hidden rounded-[2rem] p-6 sm:p-8 ${colors[tone]} ${className}`}><div className="grid h-full gap-8 lg:grid-rows-[auto_1fr]"><div className="max-w-xl"><h3 className="text-3xl leading-[1] tracking-[-.045em] sm:text-4xl">{title}</h3><p className={`mt-4 max-w-lg text-sm leading-6 ${tone === "dark" ? "text-white/55" : "text-black/55"}`}>{copy}</p></div><div className="min-h-[260px] transition-transform duration-700 ease-out group-hover:scale-[1.025]">{children}</div></div></article>;
}

function SignalVisual() {
  return <div className="flex h-full flex-col justify-end gap-2"><div className="mb-2 flex items-center gap-2 text-xs text-white/45"><Search className="h-4 w-4" />Breakout posts today</div>{[["Lara Acosta", "73% hit rate", "2.4×"], ["Justin Welsh", "58% hit rate", "1.9×"], ["Sahil Bloom", "46% hit rate", "1.7×"]].map(row => <div key={row[0]} className="grid grid-cols-[1fr_auto_auto] items-center gap-5 rounded-2xl border border-white/10 bg-white/[.06] px-4 py-4 text-sm"><span>{row[0]}</span><span className="text-white/45">{row[1]}</span><span className="text-[#d4ff4d]">{row[2]}</span></div>)}</div>;
}

function VoiceVisual() {
  return <div className="flex h-full items-end"><div className="w-full rounded-3xl bg-[#11110f] p-6 text-white"><div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-full bg-white text-xs text-black">You</div><div><p className="text-sm">Voice profile</p><p className="text-xs text-white/40">learned from 214 posts</p></div></div><p className="mt-8 text-xl leading-7">Direct. Story-led. Short sentences. One clear takeaway. No corporate language.</p><div className="mt-7 h-1 overflow-hidden rounded-full bg-white/10"><div className="h-full w-[86%] bg-[#d4ff4d]" /></div></div></div>;
}

function WeekVisual() {
  return <div className="grid h-full grid-cols-5 items-end gap-2">{["M", "T", "W", "T", "F"].map((day, index) => <div key={`${day}-${index}`} className="flex h-[70%] flex-col rounded-2xl bg-white/60 p-3"><span className="text-xs text-black/40">{day}</span>{index !== 2 && <div className={`mt-auto rounded-xl p-2 text-[10px] ${index < 2 ? "bg-[#11110f] text-white" : "bg-[#d4ff4d]"}`}>{index < 2 ? "Ready" : "Scheduled"}</div>}</div>)}</div>;
}

function ClaudeVisual() {
  return <div className="flex h-full items-end"><div className="w-full rounded-3xl border border-black/10 bg-[#f2f1ec] p-5"><div className="flex items-center gap-2 border-b border-black/10 pb-4 text-xs text-black/50"><Sparkles className="h-4 w-4" />Claude · SwipeIn connected</div><p className="mt-6 max-w-xl text-lg leading-7">Find the strongest founder story from this week and model its structure in my voice.</p><div className="mt-8 flex items-center gap-2 text-xs text-black/45"><Circle className="h-2 w-2 fill-black" />Searching your live swipe file</div></div></div>;
}

function WorkflowCard({ title, body, visual }: (typeof workflow)[number]) {
  const Visual = workflowVisuals[visual];
  return <article data-workflow-card className="min-h-[580px] rounded-[2rem] bg-white p-6 shadow-[0_30px_80px_-55px_rgba(17,17,15,.4)] sm:p-9"><h3 className="max-w-2xl text-4xl leading-[1] tracking-[-.05em] sm:text-5xl">{title}</h3><p className="mt-5 max-w-xl leading-7 text-[#64635d]">{body}</p><div className="mt-12 min-h-[300px] overflow-hidden rounded-3xl bg-[#11110f] p-5 text-white sm:p-7"><Visual /></div></article>;
}

function CalendarWorkflowVisual() {
  return <div className="h-full"><div className="mb-8 flex items-center gap-2 text-sm text-white/50"><CalendarDays className="h-4 w-4" />This week</div><WeekVisual /></div>;
}
