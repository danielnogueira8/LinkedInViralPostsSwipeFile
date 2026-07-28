import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { PageHeader } from "@/components/app-surface";
import {
  Plug,
  Shield,
  Check,
  CalendarDays,
  Repeat2,
  Magnet,
  Lightbulb,
  Clock,
  Search,
  UserPlus,
  BookOpenText,
  ExternalLink,
} from "lucide-react";
import { AiIcon } from "@/components/ai-icon";
import { AgentAvatar } from "@/components/agent-avatar";
import type { ComponentType } from "react";
import { ClaudeIcon } from "@/components/claude-icon";
import { CopyAiInstructions, CopyConnectorUrl, CopyPrompt } from "./copy";
import { requireWorkspaceId } from "@/lib/workspace";
import { PUBLIC_MCP_TOOLS } from "@/lib/mcp/public-tools";
import { SWIPEIN_MCP_INSTRUCTIONS } from "@/lib/mcp/llms-instructions";

// The apex domain 307-redirects to www; MCP clients don't follow redirects on
// the initialize POST, so the connector URL must be the canonical www host.
const CONNECTOR_URL_BASE = "https://www.tryswipein.com/api/mcp";

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
        available as a tool source. Copy one of the agents below and paste it in.
      </>
    ),
  },
];

// Workflows — copy-and-run agents. Each is framed as a named agent you put to
// work: the `tag` is the agent's name (rendered as the card's chip), the title
// is its concrete payoff, and the prompt is the brief you hand it. Every prompt
// opens with "Use the SwipeIn connector" so it reads naturally AND quietly
// reinforces the connector name from setup.
type Agent = {
  tag: string; // the agent's name — rendered next to its avatar, e.g. "Batch Writer Agent"
  slug: string; // avatar file: public/agents/<slug>.svg (a <slug>.png overrides)
  title: string;
  payoff: string; // what you walk away with — the incentive
  prompt: string;
  icon: ComponentType<{ className?: string }>;
  time: string; // ~run + light-edit time
};

const AGENTS: Agent[] = [
  {
    tag: "Bulk Writer Agent",
    slug: "bulk-writer",
    title: "10 posts, modeled on what's winning right now",
    payoff: "Walk away with 10 ready-to-edit posts in your voice — a full content pipeline in one run.",
    time: "~3 min",
    icon: AiIcon,
    prompt:
      "Use the SwipeIn connector. Call get_voice to load my writing voice. Then search_viral_posts for the 20 most viral regular posts from the last 7 days, pick the 10 with the most distinct structures, and write 10 posts modeled on them in my voice — no two using the same hook pattern, each under 1,500 characters, no AI tells (no \"Same X. Same Y.\" rhythm, no \"Here's the part everyone misses\" openers). Save each one as a draft with create_draft.",
  },
  {
    tag: "Calendar Architect Agent",
    slug: "calendar-architect",
    title: "A full week of content, no two posts alike",
    payoff: "Get a 7-day calendar where every day uses a different proven hook pattern — no repeats, no blank-page mornings.",
    time: "~4 min",
    icon: CalendarDays,
    prompt:
      "Use the SwipeIn connector. Call get_voice first to load my writing voice. Then search_viral_posts for the top 20 viral posts from the last 14 days and group them by hook pattern. Build me a 7-day posting calendar — one post per day, each using a different pattern I haven't overused, drafted in my voice and under 1,500 characters. Save every post with create_draft and schedule them across the week with schedule_draft.",
  },
  {
    tag: "Remix Agent",
    slug: "remix",
    title: "Turn one viral post into three angles",
    payoff: "One proven post becomes three distinct posts — same winning structure, three different stories you can space out.",
    time: "~2 min",
    icon: Repeat2,
    prompt:
      "Use the SwipeIn connector. Call get_voice first to load my writing voice. Then find the single most viral post from the last 30 days, pull its structure with get_template, and write me 3 different posts that keep the hook structure but tell 3 different stories from my world. Match my voice, flag the part of each that's doing the heavy lifting, and save all three with create_draft.",
  },
  {
    tag: "Offer Hunter Agent",
    slug: "offer-hunter",
    title: "Reverse-engineer the best lead magnets",
    payoff: "See exactly what's being given away to drive 500+ comments — and get an adapted offer you can run this week.",
    time: "~3 min",
    icon: Magnet,
    prompt:
      "Use the SwipeIn connector. search_viral_posts for lead-magnet posts (post_type = lead_magnet) from the last 30 days with more than 500 comments. For the top 3, tell me what they're giving away, the exact hook and CTA they used. Then call get_voice and write an adapted version of the best one for my audience, in my voice, and save it with create_draft.",
  },
  {
    tag: "Hook Scout Agent",
    slug: "hook-scout",
    title: "5 hooks to test, based on what's pulling now",
    payoff: "Skip the guesswork — get 5 hooks tied to patterns that are actually pulling engagement this week, ranked by why.",
    time: "~2 min",
    icon: Lightbulb,
    prompt:
      "Use the SwipeIn connector. Call get_voice first to load my writing voice. Then search_viral_posts for every viral post from the last 7 days and rank the hook patterns by average engagement. Give me the top 5 patterns and write one fresh hook for each in my voice, with a one-line note on why that pattern is working right now.",
  },
  {
    tag: "Timing Strategist Agent",
    slug: "timing-strategist",
    title: "Schedule around when big posts actually land",
    payoff: "Stop guessing post times — get the day-and-hour windows where the creators you track land their biggest hits.",
    time: "~2 min",
    icon: Clock,
    prompt:
      "Use the SwipeIn connector. Across the viral posts from the last 30 days, tell me which days of the week and times of day produce the most viral posts for the creators I track. Then list_drafts, pick my 5 strongest, and schedule them into those windows with schedule_draft.",
  },
  {
    tag: "Trend Radar Agent",
    slug: "trend-radar",
    title: "See this week's best posts at a glance",
    payoff: "A fast read on what's working in your niche right now — hooks, authors, and engagement, ranked.",
    time: "~1 min",
    icon: Search,
    prompt:
      "Use the SwipeIn connector. search_viral_posts for the top 10 viral posts from the last 7 days in my niche, sorted by reactions. Give me the hook, the author, and engagement for each so I can see what's working at a glance.",
  },
  {
    tag: "Roster Manager Agent",
    slug: "roster-manager",
    title: "Add a creator to track",
    payoff: "Grow your swipe file in one line — add a creator and instantly see who else you track in their niche.",
    time: "~1 min",
    icon: UserPlus,
    prompt:
      "Use the SwipeIn connector. add_account for linkedin.com/in/justinwelsh under niche 'solopreneur'. Then show me what other accounts I'm already tracking in that niche.",
  },
];

export default async function ClaudePage() {
  const workspaceId = await requireWorkspaceId();
  const connectorUrl = `${CONNECTOR_URL_BASE}?workspace_id=${encodeURIComponent(workspaceId)}`;

  return (
    <div className="space-y-8">
      <PageHeader
        meta={
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-foreground text-background">
            <ClaudeIcon className="h-4 w-4" />
          </span>
        }
        title="Claude Workflows"
        description="Advanced, external workflow support for people who want to run SwipeIn data inside Claude. For day-to-day drafting and scheduling, Cowork is the simpler path."
      />

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
          <CopyConnectorUrl url={connectorUrl} />
          <div className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
            <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              OAuth-protected. Only allow-listed accounts can sign in. Your data is never shared with
              Claude unless you explicitly call a tool.
            </span>
          </div>
        </CardContent>
      </Card>

      <section className="rounded-xl border border-border/60 bg-muted/20 p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex max-w-2xl items-start gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-background text-foreground">
              <BookOpenText className="h-4 w-4" />
            </div>
            <div className="space-y-1">
              <h2 className="text-sm font-semibold">Teach any AI to use SwipeIn correctly</h2>
              <p className="text-sm leading-6 text-muted-foreground">
                Paste one complete instruction set. The AI will verify the SwipeIn connector,
                explain what it can do, and offer useful starting prompts based on your workspace.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-col gap-2 sm:items-end">
            <CopyAiInstructions prompt={SWIPEIN_MCP_INSTRUCTIONS} />
            <a
              href="/llms.txt"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              View llms.txt
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>
      </section>

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
          <h2 className="text-xl font-semibold tracking-tight">Pick an Agent</h2>
          <p className="text-sm text-muted-foreground">
            Each agent is a ready-made prompt — copy it into any Claude chat where the SwipeIn
            connector is on, then put it to work. Tweak the niche, voice, or count to taste.
          </p>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          {AGENTS.map((agent) => {
            const Icon = agent.icon;
            return (
              <div
                key={agent.title}
                className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card p-4 shadow-[0_1px_2px_0_rgba(15,23,42,0.04)]"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="inline-flex items-center gap-2.5">
                    <span className="relative shrink-0">
                      <AgentAvatar
                        slug={agent.slug}
                        className="size-10 rounded-xl border border-border/60 bg-muted object-cover"
                      />
                      <span className="absolute -bottom-1 -right-1 grid size-4 place-items-center rounded-full border border-border/60 bg-background text-muted-foreground">
                        <Icon className="h-2.5 w-2.5" />
                      </span>
                    </span>
                    <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                      {agent.tag}
                    </span>
                  </span>
                  <span className="flex items-center gap-1 pt-1 text-[10px] tabular-nums text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {agent.time}
                  </span>
                </div>

                <div className="space-y-1.5">
                  <div className="text-sm font-semibold leading-snug">{agent.title}</div>
                  {/* The payoff line is the incentive — what you actually get. */}
                  <p className="text-[13px] leading-6 text-foreground/80">{agent.payoff}</p>
                </div>

                <div className="mt-auto rounded-lg border border-border/60 bg-muted/30 p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                      Prompt
                    </span>
                    <CopyPrompt prompt={agent.prompt} />
                  </div>
                  <p className="text-[13px] leading-6 text-muted-foreground whitespace-pre-wrap">
                    {agent.prompt}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-xl border border-border/60 bg-muted/30 p-5">
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Make any agent yours</h3>
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
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary/70" />
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
          {PUBLIC_MCP_TOOLS.map((tool) => (
            <div key={tool.name} className="flex items-start gap-3">
              <code className="rounded bg-background px-1.5 py-0.5 font-mono text-[11px] text-foreground border border-border/60 shrink-0">
                {tool.name}
              </code>
              <span className="text-muted-foreground leading-5">{tool.description}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
