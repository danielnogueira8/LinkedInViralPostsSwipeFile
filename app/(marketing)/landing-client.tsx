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
  Search,
  Sparkles,
} from "lucide-react";
import type { LandingStats } from "@/lib/landing-stats";
import { formatStatCount } from "@/lib/landing-stats";

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
    "Your voice profile, saved preferences, and feedback guide every draft. SwipeIn borrows proven structure, not somebody else's words.",
  ],
];

const included = [
  "Daily viral swipe file",
  "Drafting agent trained on your voice",
  "Content calendar and LinkedIn scheduling",
  "Up to 100 tracked creators",
  "Claude connector",
];

function PrimaryLink({ children }: { children: React.ReactNode }) {
  return (
    <Link
      href="/sign-up"
      className="group inline-flex h-11 items-center justify-center gap-2 rounded-[10px] bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/88 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
    >
      {children}
      <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

export default function LandingClient({ stats }: { stats: LandingStats }) {
  return (
    <div className="overflow-x-hidden bg-background text-foreground">
      <section className="px-4 pb-14 pt-12 sm:px-6 sm:pt-16 lg:pb-20 lg:pt-20">
        <div className="mx-auto max-w-[1180px] text-center">
          <div className="mx-auto inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-soft">
            <span className="size-1.5 rounded-full bg-accent-brand" />
            Research, write, and publish in one workspace
          </div>
          <h1 className="mx-auto mt-6 max-w-[900px] text-balance text-[clamp(2.8rem,6vw,5rem)] font-medium leading-[0.98] tracking-[-0.04em]">
            Your next LinkedIn post starts with proof.
          </h1>
          <p className="mx-auto mt-6 max-w-[650px] text-pretty text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8">
            SwipeIn finds breakout posts from creators you trust, turns the pattern into your point of view, and carries the draft all the way to your calendar.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <PrimaryLink>Start writing free</PrimaryLink>
            <Link
              href="#workflow"
              className="inline-flex h-11 items-center justify-center gap-1.5 rounded-[10px] border border-border bg-card px-5 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
            >
              See the workflow <ChevronRight className="size-4" />
            </Link>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">7 days free. No credit card required.</p>

          <div className="relative mt-12 lg:mt-16">
            <div className="absolute inset-x-[10%] bottom-0 top-[20%] -z-0 bg-accent-brand/10 blur-3xl" />
            <div className="relative overflow-hidden rounded-[14px] border border-border bg-card p-2 shadow-[0_8px_24px_-18px_rgba(28,28,26,0.4)] sm:p-3">
              <div className="flex h-9 items-center justify-between border-b border-border px-2 sm:px-3">
                <div className="flex items-center gap-1.5" aria-hidden="true">
                  <span className="size-2 rounded-full bg-border" />
                  <span className="size-2 rounded-full bg-border" />
                  <span className="size-2 rounded-full bg-border" />
                </div>
                <span className="text-[11px] font-medium text-muted-foreground">SwipeIn workspace</span>
                <span className="w-10" />
              </div>
              <Image
                src="/dashboard.png"
                alt="SwipeIn dashboard showing the content workspace and writing agent"
                width={2732}
                height={1166}
                priority
                className="mt-2 h-auto w-full rounded-[8px] border border-border/70"
              />
            </div>
          </div>
        </div>
      </section>

      <section className="border-y border-border bg-card px-4 py-5 sm:px-6">
        <div className="mx-auto flex max-w-[1180px] flex-col items-center justify-between gap-3 text-center sm:flex-row sm:text-left">
          <p className="text-sm font-medium">Built for people who publish with a point of view.</p>
          <p className="text-sm text-muted-foreground">No generic templates. No empty-page ritual. No tab parade.</p>
        </div>
      </section>

      <section id="workflow" className="px-4 py-20 sm:px-6 sm:py-28">
        <div className="mx-auto max-w-[1180px]">
          <div className="max-w-[720px]">
            <h2 className="text-balance text-[clamp(2.2rem,4vw,3.75rem)] font-medium leading-[1.04] tracking-[-0.035em]">
              One continuous path from signal to scheduled.
            </h2>
            <p className="mt-5 max-w-[620px] text-pretty text-base leading-7 text-muted-foreground">
              Every step shares the same sources, voice profile, preferences, and feedback. You move the work forward without rebuilding context.
            </p>
          </div>

          <div className="mt-14 divide-y divide-border border-y border-border">
            <WorkflowRow
              number="01"
              icon={<Search />}
              title="Find the signal"
              copy="Track the creators your buyers already read. SwipeIn surfaces posts outperforming each creator's normal baseline, so small accounts and large accounts compete on quality rather than raw reach."
            >
              <SignalPanel />
            </WorkflowRow>
            <WorkflowRow
              number="02"
              icon={<Sparkles />}
              title="Make it yours"
              copy="Ask the agent to model an angle or structure. It reads the source, your voice profile, and the feedback you have saved before producing an editable draft."
            >
              <DraftPanel />
            </WorkflowRow>
            <WorkflowRow
              number="03"
              icon={<CalendarDays />}
              title="Give it a next action"
              copy="Save the draft, refine it, place it on the board, and schedule it to LinkedIn. The original source stays attached for traceability."
            >
              <CalendarPanel />
            </WorkflowRow>
          </div>
        </div>
      </section>

      <section id="features" className="border-y border-border bg-card px-4 py-20 sm:px-6 sm:py-24">
        <div className="mx-auto max-w-[1180px]">
          <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20">
            <div>
              <h2 className="text-balance text-[clamp(2.1rem,3.5vw,3.4rem)] leading-[1.05] tracking-[-0.035em]">
                The workspace remembers what makes your content yours.
              </h2>
              <p className="mt-5 max-w-md text-pretty leading-7 text-muted-foreground">
                Good and Needs work are not throwaway reactions. Your feedback becomes durable guidance for the next draft.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Feature title="Voice profile" copy="Phrasing, rhythm, structure, and the language you avoid." />
              <Feature title="Source history" copy="The original post stays attached to every modeled draft." />
              <Feature title="Feedback memory" copy="Ratings and specific notes shape future generations." />
              <Feature title="Claude connector" copy="Use the same swipe file and context from Claude when you prefer." />
            </div>
          </div>
        </div>
      </section>

      <section className="px-4 py-16 sm:px-6 sm:py-20">
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
              <p className="text-3xl font-medium tracking-[-0.03em] sm:text-4xl">{formatStatCount(value)}</p>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{label}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="pricing" className="px-4 pb-20 pt-8 sm:px-6 sm:pb-28">
        <div className="mx-auto grid max-w-[1000px] overflow-hidden rounded-[14px] border border-border bg-card lg:grid-cols-[1fr_0.85fr]">
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
      </section>

      <section id="faq" className="border-t border-border bg-card px-4 py-20 sm:px-6 sm:py-24">
        <div className="mx-auto grid max-w-[1000px] gap-10 lg:grid-cols-[0.55fr_1fr] lg:gap-20">
          <div>
            <h2 className="text-4xl tracking-[-0.035em]">Questions, answered.</h2>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">The practical details before you start.</p>
          </div>
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
        </div>
      </section>

      <section className="px-4 py-20 sm:px-6 sm:py-28">
        <div className="mx-auto max-w-[900px] text-center">
          <h2 className="text-balance text-[clamp(2.5rem,5vw,4.5rem)] leading-[1] tracking-[-0.04em]">
            Stop asking a blank page for ideas.
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-pretty leading-7 text-muted-foreground">
            Start with what is working, add your point of view, and give every draft somewhere to go.
          </p>
          <div className="mt-8"><PrimaryLink>Start writing free</PrimaryLink></div>
        </div>
      </section>
    </div>
  );
}

function WorkflowRow({
  number,
  icon,
  title,
  copy,
  children,
}: {
  number: string;
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
        </div>
        <h3 className="mt-5 text-3xl tracking-[-0.03em] sm:text-4xl">{title}</h3>
        <p className="mt-4 max-w-lg text-pretty text-sm leading-7 text-muted-foreground sm:text-base">{copy}</p>
      </div>
      <div className="min-h-[330px] overflow-hidden rounded-[12px] border border-border bg-muted/70 p-3 sm:p-5">{children}</div>
    </article>
  );
}

function SignalPanel() {
  return (
    <div className="h-full rounded-[9px] border border-border bg-card p-4 shadow-soft sm:p-5">
      <div className="flex items-center justify-between border-b border-border pb-4">
        <div><p className="text-sm font-medium">Swipe File</p><p className="mt-1 text-xs text-muted-foreground">Breakouts from creators you track</p></div>
        <Search className="size-4 text-muted-foreground" />
      </div>
      <div className="mt-3 divide-y divide-border">
        {[
          ["April Dunford", "Positioning", "2.4x"],
          ["Dave Gerhardt", "Founder story", "1.9x"],
          ["Katelyn Bourgoin", "Buyer psychology", "1.7x"],
        ].map(([name, topic, multiple]) => (
          <div key={name} className="grid grid-cols-[1fr_auto] items-center gap-4 py-4">
            <div><p className="text-sm font-medium">{name}</p><p className="mt-1 text-xs text-muted-foreground">{topic}</p></div>
            <span className="rounded-full bg-status-med-bg px-2.5 py-1 text-xs font-medium text-status-med">{multiple} baseline</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DraftPanel() {
  return (
    <div className="flex h-full flex-col gap-3 rounded-[9px] border border-border bg-card p-4 shadow-soft sm:p-5">
      <div className="ml-auto max-w-[84%] rounded-[10px] bg-primary px-4 py-3 text-sm leading-6 text-primary-foreground">
        Model the positioning post in my voice. Make the takeaway useful for founders.
      </div>
      <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground"><Sparkles className="size-3.5 text-accent-brand" />Source and voice profile applied</div>
      <div className="rounded-[10px] border border-border bg-background p-4">
        <div className="flex items-center justify-between border-b border-border pb-3 text-xs text-muted-foreground"><span>Draft ready</span><FileText className="size-3.5" /></div>
        <p className="mt-4 text-sm leading-6">Most founders treat positioning like a sentence they need to perfect.<br /><br />It is closer to a decision they need to keep making.</p>
      </div>
    </div>
  );
}

function CalendarPanel() {
  return (
    <div className="h-full rounded-[9px] border border-border bg-card p-4 shadow-soft sm:p-5">
      <div className="flex items-center justify-between border-b border-border pb-4"><div><p className="text-sm font-medium">This week</p><p className="mt-1 text-xs text-muted-foreground">3 posts ready</p></div><CalendarDays className="size-4 text-muted-foreground" /></div>
      <div className="mt-4 grid grid-cols-3 gap-2">
        {["Tue 14", "Wed 15", "Thu 16"].map((day, index) => (
          <div key={day} className="min-h-40 rounded-[8px] border border-border bg-background p-2.5">
            <p className="text-[11px] font-medium text-muted-foreground">{day}</p>
            {index !== 1 && <div className="mt-7 rounded-[7px] border border-border bg-card p-2 text-[11px] leading-4 shadow-soft"><Circle className="mb-2 size-2 fill-accent-brand text-accent-brand" />{index === 0 ? "Positioning is a decision" : "The content-sales gap"}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function Feature({ title, copy }: { title: string; copy: string }) {
  return (
    <div className="rounded-[10px] border border-border bg-background p-5">
      <h3 className="text-sm font-medium tracking-[0]">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{copy}</p>
    </div>
  );
}
