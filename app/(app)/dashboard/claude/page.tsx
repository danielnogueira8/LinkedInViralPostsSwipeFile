import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Plug,
  Shield,
  Sparkles,
  CalendarDays,
  Repeat2,
  Magnet,
  Lightbulb,
  Clock,
  Search,
  UserPlus,
  Image as ImageIcon,
} from "lucide-react";
import type { ComponentType } from "react";
import { ClaudeIcon } from "@/components/claude-icon";
import { CopyConnectorUrl, CopyPrompt } from "./copy";

const CONNECTOR_URL = "https://linked-in-viral-posts-swipe-file.vercel.app/api/mcp";

const SETUP_STEPS: { title: string; body: React.ReactNode }[] = [
  {
    title: "Open Claude → Settings → Connectors",
    body: (
      <>
        In <span className="font-medium text-foreground">claude.ai</span> (web or desktop),
        go to your profile menu → <span className="font-medium text-foreground">Settings</span> →{" "}
        <span className="font-medium text-foreground">Connectors</span>, then click{" "}
        <span className="font-medium text-foreground">Add custom connector</span>.
      </>
    ),
  },
  {
    title: "Paste the URL and name it SwipeIn",
    body: (
      <>
        Paste the URL below into the <span className="font-medium text-foreground">MCP server URL</span>{" "}
        field and name the connector{" "}
        <span className="font-medium text-foreground">SwipeIn</span> — the workflow prompts below
        reference it by that name. Leave the Advanced fields (Client ID / Secret) empty; Claude handles
        registration automatically.
      </>
    ),
  },
  {
    title: "Sign in with the email on your Swipe File account",
    body: (
      <>
        Claude will open a sign-in screen. Use the same email you use here. The connector is locked to
        allow-listed accounts only.
      </>
    ),
  },
  {
    title: "Run a workflow",
    body: (
      <>
        Open any chat. You&apos;ll see <span className="font-medium text-foreground">SwipeIn</span>{" "}
        available as a tool source. Copy one of the plays below and paste it in.
      </>
    ),
  },
];

// Workflows — copy-and-run plays. Each leads with a concrete payoff (the
// reason to run it) and opens with "Use the SwipeIn connector" so the prompt
// reads naturally AND quietly reinforces the connector name from setup.
type Play = {
  tag: string;
  title: string;
  payoff: string; // what you walk away with — the incentive
  prompt: string;
  icon: ComponentType<{ className?: string }>;
  time: string; // ~run + light-edit time
};

const PLAYS: Play[] = [
  {
    tag: "Batch drafts",
    title: "10 posts, modeled on what's winning right now",
    payoff: "Walk away with 10 ready-to-edit posts in your voice — a week-plus of content in one run.",
    time: "~3 min",
    icon: Sparkles,
    prompt:
      "Use the SwipeIn connector. First call get_voice to load my writing voice, then fetch viral regular posts and write 10 adapted for me, modeled after stuff that went viral in the last 7 days. Match my voice, vary the hook patterns, and keep each under 1,500 characters.",
  },
  {
    tag: "Plan the week",
    title: "A full week of content, no two posts alike",
    payoff: "Get a 7-day calendar where every day uses a different proven hook pattern — no repeats, no blank-page mornings.",
    time: "~4 min",
    icon: CalendarDays,
    prompt:
      "Use the SwipeIn connector. Call get_voice first to load my writing voice. Then look at the top 20 viral posts from the last 14 days and group them by hook pattern. Build me a 7-day posting calendar — one post per day, each using a different pattern I haven't overused. Draft every post in my voice, under 1,500 characters, and label which pattern each one uses.",
  },
  {
    tag: "Remix a winner",
    title: "Turn one viral post into three angles",
    payoff: "One proven post becomes three distinct posts — same winning structure, three different stories you can space out.",
    time: "~2 min",
    icon: Repeat2,
    prompt:
      "Use the SwipeIn connector. Call get_voice first to load my writing voice. Then find the single most viral post in the last 30 days, pull its template, and write me 3 different posts that keep the hook structure but tell 3 different stories from my world. Match my voice and flag the part of each that's doing the heavy lifting.",
  },
  {
    tag: "Steal an offer",
    title: "Reverse-engineer the best lead magnets",
    payoff: "See exactly what's being given away to drive 500+ comments — and get an adapted offer you can run this week.",
    time: "~3 min",
    icon: Magnet,
    prompt:
      "Use the SwipeIn connector. Find lead-magnet posts (post_type = lead_magnet) from the last 30 days with more than 500 comments. For the top 3, tell me what they're giving away, the exact hook and CTA they used. Then call get_voice and write me an adapted version of the best one for my audience, in my voice.",
  },
  {
    tag: "Find your angle",
    title: "5 hooks to test, based on what's pulling now",
    payoff: "Skip the guesswork — get 5 hooks tied to patterns that are actually pulling engagement this week, ranked by why.",
    time: "~2 min",
    icon: Lightbulb,
    prompt:
      "Use the SwipeIn connector. Call get_voice first to load my writing voice. Then look at every viral post from the last batch and rank the hook patterns by average engagement. Give me the top 5 patterns and write one fresh hook for each in my voice, with a one-line note on why that pattern is working right now.",
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
  {
    tag: "Scout",
    title: "See this week's best posts at a glance",
    payoff: "A fast read on what's working in your niche right now — hooks, authors, and engagement, ranked.",
    time: "~1 min",
    icon: Search,
    prompt:
      "Use the SwipeIn connector. Pull the top 10 viral posts from the last 7 days in my niche, sorted by reactions. Give me the hook, the author, and engagement for each so I can see what's working at a glance.",
  },
  {
    tag: "Manage",
    title: "Add a creator to track",
    payoff: "Grow your swipe file in one line — add a creator and instantly see who else you track in their niche.",
    time: "~1 min",
    icon: UserPlus,
    prompt:
      "Use the SwipeIn connector. Add linkedin.com/in/justinwelsh to my tracked accounts under niche 'solopreneur'. Then show me what other accounts I'm already tracking in that niche.",
  },
  {
    tag: "On-brand visuals",
    title: "Recolor a viral graphic in your brand",
    payoff: "Turn a proven graphic post into an on-brand image prompt — your colors, your fonts, ready to paste into gpt-image-1.",
    time: "~2 min",
    icon: ImageIcon,
    prompt:
      "Use the SwipeIn connector. Find the most viral graphic post in the last 14 days, then call get_brand for 'Acme' and write a gpt-image-1 prompt that recreates it in Acme's colors and fonts, keeping the original layout and copy.",
  },
];

export default function ClaudePage() {
  return (
    <div className="space-y-8">
      <div className="flex items-start gap-4">
        <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-foreground text-background">
          <ClaudeIcon className="h-5 w-5" />
        </div>
        <div className="space-y-1">
          <h1 className="text-4xl font-display tracking-tight">Claude Workflows</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Connect your swipe file to Claude once, then stop scrolling — copy a ready-made play and
            walk away with finished posts, drafted from your actual data.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Plug className="h-4 w-4 text-muted-foreground" />
            Your MCP connector URL
          </CardTitle>
          <CardDescription>
            Paste this into Claude → Settings → Connectors → Add custom connector, and name it{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px] text-foreground">
              SwipeIn
            </code>{" "}
            — every prompt below references it by that name.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CopyConnectorUrl url={CONNECTOR_URL} />
          <div className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
            <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              OAuth-protected. Only allow-listed accounts can sign in. Your data is never shared with
              Claude unless you explicitly call a tool.
            </span>
          </div>
        </CardContent>
      </Card>

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold tracking-tight">Setup — 4 steps</h2>
          <p className="text-sm text-muted-foreground">Takes about a minute. One-time only.</p>
        </div>
        <ol className="grid gap-3 md:grid-cols-2">
          {SETUP_STEPS.map((step, i) => (
            <li
              key={step.title}
              className="rounded-xl border border-border/60 bg-card p-4 shadow-[0_1px_2px_0_rgba(15,23,42,0.04)]"
            >
              <div className="flex items-start gap-3">
                <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-foreground text-[12px] font-medium text-background">
                  {i + 1}
                </div>
                <div className="space-y-1">
                  <div className="text-sm font-medium">{step.title}</div>
                  <div className="text-sm text-muted-foreground leading-6">{step.body}</div>
                </div>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold tracking-tight">Pick a play</h2>
          <p className="text-sm text-muted-foreground">
            Copy a prompt into any Claude chat where the SwipeIn connector is on. Tweak the niche,
            voice, or count to taste.
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
            ["Lock your voice", "Generate your voice in the Voice tab, then ask Claude to “call get_voice and match my voice” for an instant style match."],
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

      <section className="rounded-xl border border-border/60 bg-muted/30 p-5">
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Tools Claude can call</h3>
          <p className="text-sm text-muted-foreground">
            Once connected, the agent has access to these tools — most of the time you don&apos;t need
            to think about them, just ask in plain English.
          </p>
        </div>
        <div className="mt-4 grid gap-2 text-[13px] sm:grid-cols-2">
          {[
            ["search_viral_posts", "Filter by niche, date range, virality, post type."],
            ["get_post", "Pull a full post by id — text, engagement, template."],
            ["list_niches", "All niches in your workspace, with post counts."],
            ["get_top_from_batch", "Top N posts from the most recent scrape."],
            ["get_voice", "Your synthesized writing voice — call before drafting."],
            ["list_accounts", "Your tracked creators, filterable by niche."],
            ["add_account", "Add a LinkedIn profile to track."],
            ["update_account", "Edit name or niche on a tracked account."],
            ["remove_account", "Soft-archive an account (history kept)."],
            ["restore_account", "Un-archive a previously removed account."],
            ["list_brands", "List every brand in your workspace — colors, logo, fonts."],
            ["get_brand", "Fetch a single brand by name or id for image prompts."],
          ].map(([name, desc]) => (
            <div key={name} className="flex items-start gap-3">
              <code className="rounded bg-background px-1.5 py-0.5 font-mono text-[11px] text-foreground border border-border/60 shrink-0">
                {name}
              </code>
              <span className="text-muted-foreground leading-5">{desc}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
