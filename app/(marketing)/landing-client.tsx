"use client";

import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  CalendarDays,
  Check,
  ChevronRight,
  Circle,
  FileText,
  History,
  Library,
  LayoutDashboard,
  Mic2,
  Palette,
  Search,
  ThumbsUp,
  Zap,
} from "lucide-react";
import { AiIcon } from "@/components/ai-icon";
import type { LandingStats, LandingTopCreator } from "@/lib/landing-stats";
import {
  AgentTrace,
  CountUp,
  Reveal,
  RotatingPhrases,
  SpotlightCard,
} from "./landing-motion";

const faqs = [
  [
    "Does SwipeIn write the whole post?",
    "Yes. It can find an angle, draft in your voice, revise the copy, and leave the result ready for your approval.",
  ],
  [
    "Can it publish to LinkedIn?",
    "Yes. Connect LinkedIn in Settings and schedule approved drafts directly. You can also use the calendar as a planning-only workflow.",
  ],
  [
    "Where do the source posts come from?",
    "SwipeIn pulls public posts from creators you choose, then compares each post with that creator's normal performance.",
  ],
  [
    "Will the drafts sound like me?",
    "Choose your own voice or a creator style you have saved. SwipeIn combines that voice with proven frameworks while keeping the ideas and wording original.",
  ],
];

const included = [
  "Daily viral swipe file",
  "Your voice and saved creator styles",
  "Templates from proven post frameworks",
  "Content calendar and LinkedIn scheduling",
  "Up to 100 tracked creators",
  "Claude MCP connector",
];

// Illustrative sample for the marquee — the shapes of creators people track,
// not real users. Avatars generated with DiceBear Notionists (CC0).
const sampleCreators = [
  ["Elena Marsh", "B2B SaaS", "elena-marsh"],
  ["Derek Osei", "Sales", "derek-osei"],
  ["Priya Nair", "Startups", "priya-nair"],
  ["Tom Alvarez", "Marketing", "tom-alvarez"],
  ["Sofia Lindqvist", "Product", "sofia-lindqvist"],
  ["Marcus Webb", "Venture", "marcus-webb"],
  ["Hana Sato", "Growth", "hana-sato"],
  ["Leo Moreau", "Bootstrapping", "leo-moreau"],
] as const;

function PrimaryLink({ children }: { children: React.ReactNode }) {
  return (
    <Link
      href="/sign-up"
      className="group inline-flex h-11 items-center justify-center gap-2 rounded-[10px] bg-primary px-5 text-sm font-medium text-primary-foreground transition-[background-color,box-shadow,scale] hover:bg-primary/88 hover:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.18)] focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30 active:scale-[0.98]"
    >
      {children}
      <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

export default function LandingClient({
  stats,
  topCreators,
}: {
  stats: LandingStats;
  topCreators: LandingTopCreator[];
}) {
  return (
    <div className="overflow-x-hidden bg-background text-foreground">
      <section className="relative px-4 pb-14 pt-12 sm:px-6 sm:pt-16 lg:pb-24 lg:pt-20">
        <div aria-hidden="true" className="hero-dot-grid absolute inset-0" />
        <div className="relative mx-auto max-w-[1180px] text-center">
          <div className="reveal-up mx-auto inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-soft" style={{ "--reveal-delay": "0ms" } as React.CSSProperties}>
            <span className="live-dot size-1.5 rounded-full bg-accent-brand" />
            Your agent for research, writing, and publishing
          </div>
          <h1 className="reveal-up mx-auto mt-6 max-w-[900px] text-balance text-[clamp(2.8rem,6vw,5rem)] font-medium leading-[0.98] tracking-[-0.04em]" style={{ "--reveal-delay": "60ms" } as React.CSSProperties}>
            Your next LinkedIn post starts with proof.
          </h1>
          <p className="reveal-up mx-auto mt-6 max-w-[650px] text-pretty text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8" style={{ "--reveal-delay": "110ms" } as React.CSSProperties}>
            SwipeIn&apos;s agent finds breakout posts from creators you trust, drafts them in your voice, and lines them up on your calendar. You approve every word.
          </p>
          <div className="reveal-up mt-8 flex flex-wrap items-center justify-center gap-3" style={{ "--reveal-delay": "150ms" } as React.CSSProperties}>
            <PrimaryLink>Start writing free</PrimaryLink>
            <Link
              href="#workflow"
              className="inline-flex h-11 items-center justify-center gap-1.5 rounded-[10px] border border-border bg-card px-5 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
            >
              See the workflow <ChevronRight className="size-4" />
            </Link>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">7 days free. No credit card required.</p>

          <div className="reveal-up relative mt-12 lg:mt-16" style={{ "--reveal-delay": "210ms" } as React.CSSProperties}>
            <div className="absolute inset-x-[10%] bottom-0 top-[20%] -z-0 bg-accent-brand/10 blur-3xl" />
            <div className="gradient-hairline relative overflow-hidden rounded-[14px] bg-card p-2 shadow-[0_8px_24px_-18px_rgba(28,28,26,0.4)] sm:p-3">
              <div className="flex h-9 items-center justify-between border-b border-border px-2 sm:px-3">
                <div className="flex w-10 items-center gap-1.5" aria-hidden="true">
                  <span className="live-dot size-1.5 rounded-full bg-accent-brand" />
                </div>
                <span className="text-[11px] font-medium text-muted-foreground">SwipeIn workspace · agent active</span>
                <span className="w-10" />
              </div>
              <Image
                src="/swipe-file-workspace.png"
                alt="SwipeIn Swipe File workspace showing filters and high-performing posts from tracked creators"
                width={2940}
                height={1622}
                priority
                className="mt-2 h-auto w-full rounded-[8px] outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
              />
            </div>
            <div className="relative z-10 mx-auto -mt-8 w-full max-w-[400px] text-left sm:-mt-14 sm:ml-6 sm:mr-auto lg:ml-10">
              <AgentTrace />
            </div>
          </div>
        </div>
      </section>

      <section aria-label="Example tracked creators" className="border-y border-border bg-card px-4 py-6 sm:px-6">
        <div className="mx-auto max-w-[1180px]">
          <p className="text-center text-xs font-medium text-muted-foreground">
            A swipe file built from the creators your buyers already read
          </p>
          <div className="scroll-fade-x mt-4 overflow-hidden">
            <div className="marquee-track flex w-max items-center gap-3">
              {(() => {
                const marqueeCreators =
                  topCreators.length > 0
                    ? topCreators
                    : sampleCreators.map(([name, niche, avatar]) => ({
                        name,
                        niche,
                        imageUrl: `/creator-icons/${avatar}.svg`,
                      }));
                return [...marqueeCreators, ...marqueeCreators].map(({ name, niche, imageUrl }, index) => (
                  <span
                    key={`${name}-${index}`}
                    aria-hidden={index >= marqueeCreators.length}
                    className="inline-flex shrink-0 items-center gap-2.5 rounded-full border border-border bg-background py-1.5 pl-1.5 pr-4"
                  >
                    <span className="relative size-7 overflow-hidden rounded-full border border-border bg-muted">
                      <Image src={imageUrl} alt="" fill loading="eager" className="object-cover" />
                    </span>
                    <span className="text-xs font-medium">{name}</span>
                    <span className="text-[11px] text-muted-foreground">{niche}</span>
                  </span>
                ));
              })()}
            </div>
          </div>
        </div>
      </section>

      <section className="px-4 py-5 sm:px-6">
        <div className="mx-auto flex max-w-[1180px] flex-col items-center justify-between gap-3 text-center sm:flex-row sm:text-left">
          <p className="text-sm font-medium">Built for people who publish with a point of view.</p>
          <p className="text-sm text-muted-foreground">
            No generic templates. No empty-page ritual.{" "}
            <RotatingPhrases phrases={["No tab parade.", "No blank page.", "No guessing what works."]} />
          </p>
        </div>
      </section>

      <section id="workflow" className="px-4 py-20 sm:px-6 sm:py-28">
        <div className="mx-auto max-w-[1180px]">
          <Reveal>
            <div className="max-w-[720px]">
              <h2 className="text-balance text-[clamp(2.2rem,4vw,3.75rem)] font-medium leading-[1.04] tracking-[-0.035em]">
                One continuous path from signal to scheduled.
              </h2>
              <p className="mt-5 max-w-[620px] text-pretty text-base leading-7 text-muted-foreground">
                Every step shares the same sources, voice profile, preferences, and feedback. The agent does the legwork — you make the final call on everything that ships.
              </p>
            </div>
          </Reveal>

          <div className="mt-14 divide-y divide-border border-y border-border">
            <Reveal>
              <WorkflowRow
                number="01"
                actor="Agent"
                icon={<Search />}
                title="Find the signal"
                copy="Track the creators your buyers already read. SwipeIn surfaces posts outperforming each creator's normal baseline, so small accounts and large accounts compete on quality rather than raw reach."
              >
                <SignalPanel />
              </WorkflowRow>
            </Reveal>
            <Reveal>
              <WorkflowRow
                number="02"
                actor="Agent"
                icon={<AiIcon />}
                title="Make it yours"
                copy="Choose your voice or a saved creator style, then start from a proven post framework. The agent applies the source, style, and feedback before producing an editable draft."
              >
                <DraftPanel />
              </WorkflowRow>
            </Reveal>
            <Reveal>
              <WorkflowRow
                number="03"
                actor="Agent"
                icon={<LayoutDashboard />}
                title="Manage your posts"
                copy="The agent moves ideas, drafts, approved posts, and published work through one clear board. See what needs attention and keep every source attached."
              >
                <PostsBoardPanel />
              </WorkflowRow>
            </Reveal>
            <Reveal>
              <WorkflowRow
                number="04"
                actor="You approve"
                icon={<CalendarDays />}
                title="Give it a next action"
                copy="Review the draft, request changes or approve it, and schedule it to LinkedIn. The original source stays attached for traceability."
              >
                <CalendarPanel />
              </WorkflowRow>
            </Reveal>
          </div>
        </div>
      </section>

      <section id="features" className="surface-noise relative border-y border-border bg-card px-4 py-20 sm:px-6 sm:py-24">
        <div className="relative mx-auto max-w-[1180px]">
          <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20">
            <Reveal>
              <div>
                <h2 className="text-balance text-[clamp(2.1rem,3.5vw,3.4rem)] leading-[1.05] tracking-[-0.035em]">
                  The workspace remembers what makes your content yours.
                </h2>
                <p className="mt-5 max-w-md text-pretty leading-7 text-muted-foreground">
                  Good and Needs work are not throwaway reactions. Your feedback becomes durable guidance for the next draft.
                </p>
              </div>
            </Reveal>
            <div className="grid gap-3 sm:grid-cols-2">
              {([
                [<Mic2 key="i" />, "Voice profile", "Phrasing, rhythm, structure, and the language you avoid."],
                [<History key="i" />, "Source history", "The original post stays attached to every modeled draft."],
                [<ThumbsUp key="i" />, "Feedback memory", "Ratings and specific notes shape future generations."],
                [<Palette key="i" />, "Creator styles", "Write in your own voice or choose the style of a creator you follow."],
                [<Library key="i" />, "Proven frameworks", "Turn high-performing posts into reusable templates for new topics."],
                [<Image key="i" src="/claude.svg" alt="" width={18} height={18} />, "Claude MCP connector", "Bring the same swipe file, creator styles, and proven templates into Claude through MCP."],
              ] as const).map(([icon, title, copy], index) => (
                <Reveal key={title} delay={index * 60}>
                  <Feature icon={icon} title={title} copy={copy} />
                </Reveal>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="px-4 py-16 sm:px-6 sm:py-20">
        <Reveal>
          <div className="mx-auto grid max-w-[1180px] grid-cols-2 border-y border-border sm:grid-cols-4">
            {([
              { value: stats.postsPulledToday, label: "posts pulled today" },
              { value: stats.creatorsTracked, label: "creators tracked" },
              { value: stats.viralPostsArchived, label: "viral posts archived" },
              { value: stats.templatesGenerated, label: "patterns extracted" },
            ] satisfies { value: number; label: string }[]).map(({ value, label }, index) => (
              <div
                key={label}
                className={`px-4 py-7 sm:px-6 ${index % 2 ? "border-l border-border" : ""} ${index > 1 ? "border-t border-border sm:border-t-0" : ""} ${index > 0 ? "sm:border-l sm:border-border" : ""}`}
              >
                <p className="text-3xl font-medium tracking-[-0.03em] sm:text-4xl">
                  <CountUp value={value} />
                </p>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{label}</p>
              </div>
            ))}
          </div>
        </Reveal>
      </section>

      <section id="pricing" className="px-4 pb-20 pt-8 sm:px-6 sm:pb-28">
        <Reveal>
          <div className="gradient-hairline mx-auto grid max-w-[1000px] overflow-hidden rounded-[14px] bg-card lg:grid-cols-[1fr_0.85fr]">
            <div className="p-7 sm:p-10 lg:p-12">
              <p className="text-sm font-medium text-muted-foreground">One complete workspace</p>
              <h2 className="mt-4 max-w-lg text-balance text-[clamp(2.3rem,4vw,3.7rem)] leading-[1.03] tracking-[-0.04em]">
                Publish from evidence, not pressure.
              </h2>
              <p className="mt-5 max-w-md leading-7 text-muted-foreground">
                Research, writing, planning, and publishing stay together. Try the full product for seven days.
              </p>
              <div className="mt-8"><PrimaryLink>Start your free week</PrimaryLink></div>
            </div>
            <div className="border-t border-border bg-muted/60 p-7 sm:p-10 lg:border-l lg:border-t-0 lg:p-12">
              <p className="text-sm font-medium">Launch plan</p>
              <div className="mt-3 flex items-end gap-2">
                <span className="pb-1 text-lg text-muted-foreground line-through decoration-1">$99</span>
                <span className="text-5xl font-medium tracking-[-0.04em]">$79</span>
                <span className="pb-1 text-sm text-muted-foreground">per month</span>
              </div>
              <ul className="mt-8 space-y-3">
                {included.map((item) => (
                  <li key={item} className="flex items-start gap-3 text-sm leading-6">
                    <Check className="mt-1 size-3.5 text-accent-brand" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Reveal>
      </section>

      <section id="faq" className="surface-noise relative border-t border-border bg-card px-4 py-20 sm:px-6 sm:py-24">
        <div className="relative mx-auto grid max-w-[1000px] gap-10 lg:grid-cols-[0.55fr_1fr] lg:gap-20">
          <Reveal>
            <div>
              <h2 className="text-4xl tracking-[-0.035em]">Questions, answered.</h2>
              <p className="mt-4 text-sm leading-6 text-muted-foreground">The practical details before you start.</p>
            </div>
          </Reveal>
          <Reveal delay={100}>
            <div className="border-t border-border">
              {faqs.map(([question, answer]) => (
                <details key={question} className="group border-b border-border py-5">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30">
                    {question}
                    <span className="text-xl font-light text-muted-foreground transition-transform group-open:rotate-45">+</span>
                  </summary>
                  <p className="max-w-2xl pt-4 text-sm leading-6 text-muted-foreground">{answer}</p>
                </details>
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      <section className="px-4 py-20 sm:px-6 sm:py-28">
        <Reveal>
          <div className="mx-auto max-w-[900px] text-center">
            <h2 className="text-balance text-[clamp(2.5rem,5vw,4.5rem)] leading-[1] tracking-[-0.04em]">
              Stop asking a blank page for ideas.
            </h2>
            <p className="mx-auto mt-5 max-w-xl text-pretty leading-7 text-muted-foreground">
              Start with what is working, add your point of view, and give every draft somewhere to go.
            </p>
            <div className="mt-8"><PrimaryLink>Start writing free</PrimaryLink></div>
          </div>
        </Reveal>
      </section>
    </div>
  );
}

function WorkflowRow({
  number,
  actor,
  icon,
  title,
  copy,
  children,
}: {
  number: string;
  actor: "Agent" | "You approve";
  icon: React.ReactNode;
  title: string;
  copy: string;
  children: React.ReactNode;
}) {
  return (
    <article className="grid gap-8 py-12 lg:grid-cols-[0.75fr_1.25fr] lg:items-center lg:gap-16 lg:py-16">
      <div>
        <div className="flex items-center gap-3 text-xs font-medium text-muted-foreground">
          <span>{number}</span>
          <span className="grid size-8 place-items-center rounded-[8px] border border-border bg-card [&_svg]:size-4">{icon}</span>
          {actor === "Agent" ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
              <span className="size-1 rounded-full bg-accent-brand" />
              Agent
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground">
              <Check className="size-3" />
              You approve
            </span>
          )}
        </div>
        <h3 className="mt-5 text-3xl tracking-[-0.03em] sm:text-4xl">{title}</h3>
        <p className="mt-4 max-w-lg text-pretty text-sm leading-7 text-muted-foreground sm:text-base">{copy}</p>
      </div>
      <div className="min-h-[330px] overflow-hidden rounded-[14px] bg-muted/70 p-3 sm:p-5">{children}</div>
    </article>
  );
}

function SignalPanel() {
  return (
    <div className="h-full rounded-[12px] bg-card p-4 shadow-soft sm:p-5">
      <div className="flex items-center justify-between border-b border-border pb-4">
        <div><p className="text-sm font-medium">Swipe File</p><p className="mt-1 text-xs text-muted-foreground">Breakouts from creators you track</p></div>
        <Search className="size-4 text-muted-foreground" />
      </div>
      <div className="mt-4 overflow-hidden rounded-[8px] bg-background outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10">
        <Image
          src="/swipe-file-posts.png"
          alt="SwipeIn Swipe File showing three high-performing LinkedIn posts with engagement metrics and modeling actions"
          width={2762}
          height={1644}
          className="h-auto w-full"
        />
      </div>
    </div>
  );
}

function DraftPanel() {
  return (
    <div className="flex h-full flex-col gap-3 rounded-[12px] bg-card p-4 shadow-soft sm:p-5">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="flex items-center gap-2"><AiIcon className="size-3.5 text-accent-brand" />Drafted from your source</span>
        <span>Draft 1</span>
      </div>
      <div className="flex flex-col gap-1.5 rounded-[10px] border border-border bg-background px-3.5 py-3">
        {[
          "Applied your voice profile",
          "Hook kept under 8 words",
          "Source attached · 3.2× baseline",
        ].map((note) => (
          <p key={note} className="flex items-center gap-2 text-xs text-muted-foreground">
            <Check className="size-3 shrink-0 text-muted-foreground" />
            {note}
          </p>
        ))}
      </div>
      <div className="rounded-[10px] border border-border bg-background p-4">
        <div className="flex items-center justify-between border-b border-border pb-3">
        <div className="flex items-center gap-2.5"><span className="grid size-8 place-items-center rounded-full bg-primary text-xs font-medium text-primary-foreground">JD</span><div><p className="text-sm font-medium">John Doe</p><p className="text-xs text-muted-foreground">Ready to review</p></div></div>
          <FileText className="size-4 text-muted-foreground" />
        </div>
        <p className="mt-4 text-sm leading-6">3 AI tools I actually use to ghostwrite LinkedIn content.<br /><br />Not a &quot;best AI tools&quot; list. These survived 6 years of writing for founders and 30+ posts that crossed 1,000 comments.<br /><br />1/ Claude → for overall work<br />The one I live in all day. Best for research, create sales assets, and planning your content schedule.<br /><br />2/ SwipeIn → for research &amp; writing<br />This is where I source all my inspiration from. I track 100+ creators and get fed their best content daily. Trained on my voice and thousands of viral posts.<br /><br />3/ Notion → for content calendars<br />Where my content planning lives: ideas, drafts, scheduled posts, client feedback. Still the best workspace.</p>
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <button type="button" className="min-h-10 rounded-[8px] bg-state-success-bg px-3 text-xs font-medium text-state-success transition-[background-color,scale] hover:bg-state-success-bg/70 active:scale-[0.96]">Good</button>
          <button type="button" className="min-h-10 rounded-[8px] bg-state-danger-bg px-3 text-xs font-medium text-state-danger transition-[background-color,scale] hover:bg-state-danger-bg/70 active:scale-[0.96]">Needs work</button>
          <span className="ml-auto text-xs text-muted-foreground">View source</span>
        </div>
      </div>
    </div>
  );
}

function PostsBoardPanel() {
  return (
    <div className="h-full overflow-hidden rounded-[12px] bg-card p-2 shadow-soft sm:p-3">
      <Image
        src="/posts-board.png"
        alt="SwipeIn Posts board organizing ideas, drafts, ready, scheduled, and published posts"
        width={2748}
        height={1344}
        className="h-auto w-full rounded-[8px] outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
      />
    </div>
  );
}

function CalendarPanel() {
  return (
    <div className="h-full rounded-[12px] bg-card p-4 shadow-soft sm:p-5">
      <div className="flex items-center justify-between border-b border-border pb-4"><div><p className="text-sm font-medium">This week</p><p className="mt-1 text-xs text-muted-foreground">3 posts ready</p></div><span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-[11px] font-medium text-muted-foreground"><Zap className="size-3" />Auto-scheduled</span></div>
      <div className="mt-4 grid grid-cols-3 gap-2">
        {["Tue 14", "Wed 15", "Thu 16"].map((day, index) => (
          <div key={day} className="min-h-40 rounded-[8px] border border-border bg-background p-2.5">
            <p className="text-xs font-medium text-muted-foreground">{day}</p>
            {index !== 1 && <div className="mt-7 rounded-[7px] bg-card p-2 text-xs leading-4 shadow-soft"><Circle className="mb-2 size-2 fill-accent-brand text-accent-brand" />{index === 0 ? "Positioning is a decision" : "The content-sales gap"}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function Feature({ icon, title, copy }: { icon: React.ReactNode; title: string; copy: string }) {
  return (
    <SpotlightCard className="h-full rounded-[10px] border border-border bg-background p-5">
      <span className="grid size-9 place-items-center rounded-[8px] border border-border bg-card text-muted-foreground [&_svg]:size-4">{icon}</span>
      <h3 className="mt-5 text-sm font-medium tracking-[0]">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{copy}</p>
    </SpotlightCard>
  );
}
