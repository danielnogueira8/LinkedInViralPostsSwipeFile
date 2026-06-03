import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Workflow,
  Sparkles,
  CalendarDays,
  Repeat2,
  Magnet,
  Lightbulb,
  Clock,
  Plug,
  ArrowRight,
} from "lucide-react";
import type { ComponentType } from "react";
import Link from "next/link";
import { CopyConnectorUrl, CopyPrompt } from "../claude/copy";

// Workflows — opinionated, copy-and-run plays for turning the swipe file into
// finished content with Claude. The Claude tab teaches *how to connect*; this
// tab teaches *what to actually do with it once connected*, with a clear
// payoff per play so people are pulled into running them.

const CONNECTOR_URL = "https://linked-in-viral-posts-swipe-file.vercel.app/api/mcp";

// Every prompt opens with "Use the SwipeIn connector" on purpose — it both
// reads naturally and quietly trains people to name the connector "SwipeIn"
// when they add it, so Claude resolves the reference. The setup callout up top
// makes the naming explicit; the prompts reinforce it.
type Play = {
  tag: string;
  title: string;
  // The hook — what the user walks away with. This is the incentive to run it.
  payoff: string;
  prompt: string;
  icon: ComponentType<{ className?: string }>;
  // ~how long the run + light editing takes, set expectations.
  time: string;
};

const PLAYS: Play[] = [
  {
    tag: "Batch drafts",
    title: "10 posts, modeled on what's winning right now",
    payoff: "Walk away with 10 ready-to-edit posts in your voice — a week-plus of content in one run.",
    time: "~3 min",
    icon: Sparkles,
    prompt:
      "Use the SwipeIn connector to fetch viral regular posts and write 10 adapted for me, modeled after stuff that went viral in the last 7 days. Keep my voice, vary the hook patterns, and keep each under 1,500 characters.",
  },
  {
    tag: "Plan the week",
    title: "A full week of content, no two posts alike",
    payoff: "Get a 7-day calendar where every day uses a different proven hook pattern — no repeats, no blank-page mornings.",
    time: "~4 min",
    icon: CalendarDays,
    prompt:
      "Use the SwipeIn connector. Look at the top 20 viral posts from the last 14 days and group them by hook pattern. Build me a 7-day posting calendar — one post per day, each using a different pattern I haven't overused. Draft every post in my voice, under 1,500 characters, and label which pattern each one uses.",
  },
  {
    tag: "Remix a winner",
    title: "Turn one viral post into three angles",
    payoff: "One proven post becomes three distinct posts — same winning structure, three different stories you can space out.",
    time: "~2 min",
    icon: Repeat2,
    prompt:
      "Use the SwipeIn connector to find the single most viral post in the last 30 days. Pull its template, then write me 3 different posts that keep the hook structure but tell 3 different stories from my world. Keep my voice and flag the part of each that's doing the heavy lifting.",
  },
  {
    tag: "Steal an offer",
    title: "Reverse-engineer the best lead magnets",
    payoff: "See exactly what's being given away to drive 500+ comments — and get an adapted offer you can run this week.",
    time: "~3 min",
    icon: Magnet,
    prompt:
      "Use the SwipeIn connector. Find lead-magnet posts (post_type = lead_magnet) from the last 30 days with more than 500 comments. For the top 3, tell me what they're giving away, the exact hook and CTA they used, and write me an adapted version of the best one for my audience.",
  },
  {
    tag: "Find your angle",
    title: "5 hooks to test, based on what's pulling now",
    payoff: "Skip the guesswork — get 5 hooks tied to patterns that are actually pulling engagement this week, ranked by why.",
    time: "~2 min",
    icon: Lightbulb,
    prompt:
      "Use the SwipeIn connector. Look at every viral post from the last batch and rank the hook patterns by average engagement. Give me the top 5 patterns and write one fresh hook for each in my voice, with a one-line note on why that pattern is working right now.",
  },
  {
    tag: "Best time",
    title: "Schedule around when big posts actually land",
    payoff: "Stop guessing post times — get the day-and-hour windows where the creators you track land their biggest hits.",
    time: "~2 min",
    icon: Clock,
    prompt:
      "Use the SwipeIn connector. Across the viral posts from the last 30 days, tell me which days of the week and times of day produce the most viral posts for the creators I track. Then suggest a posting schedule for my 5 best drafts this week that lines up with those windows.",
  },
];

export default function WorkflowsPage() {
  return (
    <div className="space-y-8">
      <div className="flex items-start gap-4">
        <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/15">
          <Workflow className="h-5 w-5" />
        </div>
        <div className="space-y-1">
          <h1 className="text-4xl font-display tracking-tight">Workflows</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Copy-and-run plays that turn your swipe file into finished posts. Each one hands Claude your
            real data through the SwipeIn connector — pick a play, paste it, and walk away with content.
          </p>
        </div>
      </div>

      {/* Teach-the-name callout: workflows only work if the connector is
          actually named "SwipeIn", because every prompt references it by name. */}
      <Card className="border-primary/20 bg-primary/[0.03]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Plug className="h-4 w-4 text-primary" />
            First, name your connector{" "}
            <code className="rounded bg-background px-1.5 py-0.5 font-mono text-[13px] text-foreground border border-border/60">
              SwipeIn
            </code>
          </CardTitle>
          <CardDescription>
            Every prompt below says &ldquo;Use the SwipeIn connector&rdquo; — so when you add it in Claude,
            give it exactly that name. That&apos;s how Claude knows which tools to reach for.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <CopyConnectorUrl url={CONNECTOR_URL} />
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
            <span>
              Haven&apos;t connected yet? The full 4-step setup lives on the
            </span>
            <Link
              href="/dashboard/claude"
              className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
            >
              Claude tab
              <ArrowRight className="h-3 w-3" />
            </Link>
            <span>— just be sure to name it SwipeIn there too.</span>
          </div>
        </CardContent>
      </Card>

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold tracking-tight">Pick a play</h2>
          <p className="text-sm text-muted-foreground">
            Copy a prompt into any Claude chat where the SwipeIn connector is on. Tweak the niche, voice,
            or count to taste.
          </p>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          {PLAYS.map((play) => {
            const Icon = play.icon;
            return (
              <div
                key={play.title}
                className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card p-4 shadow-[0_1px_2px_0_rgba(15,23,42,0.04)]"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                    <Icon className="h-3 w-3" />
                    {play.tag}
                  </span>
                  <span className="flex items-center gap-1 text-[10px] tabular-nums text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {play.time}
                  </span>
                </div>

                <div className="space-y-1.5">
                  <div className="text-sm font-semibold leading-snug">{play.title}</div>
                  {/* The payoff line is the incentive — what you actually get. */}
                  <p className="text-[13px] leading-6 text-foreground/80">{play.payoff}</p>
                </div>

                <div className="mt-auto rounded-lg border border-border/60 bg-muted/30 p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                      Prompt
                    </span>
                    <CopyPrompt prompt={play.prompt} />
                  </div>
                  <p className="text-[13px] leading-6 text-muted-foreground whitespace-pre-wrap">
                    {play.prompt}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-xl border border-border/60 bg-muted/30 p-5">
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Make any play yours</h3>
          <p className="text-sm text-muted-foreground">
            These are starting points, not scripts. The prompts get sharper when you add your own
            context — Claude already has your data, so it just needs to know who you&apos;re writing for.
          </p>
        </div>
        <ul className="mt-4 grid gap-2 text-[13px] text-muted-foreground sm:grid-cols-2">
          {[
            ["Name your niche", "“…in the B2B SaaS niche” narrows it to the creators that matter to you."],
            ["Describe your reader", "“I sell to mid-market RevOps leaders” makes every draft land for them."],
            ["Change the volume", "Ask for 3 instead of 10, or a 14-day calendar instead of a week."],
            ["Lock your voice", "Paste 2-3 of your own posts and say “match this voice” for an instant style match."],
          ].map(([title, desc]) => (
            <li key={title} className="flex items-start gap-2">
              <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary/70" />
              <span className="leading-5">
                <span className="font-medium text-foreground">{title}.</span> {desc}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
