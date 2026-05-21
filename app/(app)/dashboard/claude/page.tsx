import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Plug, MessageSquare, Shield } from "lucide-react";
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
    title: "Paste the Swipe File connector URL",
    body: (
      <>
        Paste the URL below into the <span className="font-medium text-foreground">MCP server URL</span>{" "}
        field. Leave the Advanced fields (Client ID / Secret) empty — Claude handles registration automatically.
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
    title: "Start asking",
    body: (
      <>
        Open any chat. You&apos;ll see <span className="font-medium text-foreground">linkedin-swipe</span>{" "}
        available as a tool source. Try one of the example prompts below.
      </>
    ),
  },
];

const PROMPTS: { title: string; tag: string; prompt: string }[] = [
  {
    tag: "Discover",
    title: "Find this week's best posts",
    prompt:
      "Use the linkedin-swipe connector. Pull the top 10 viral posts from the last 7 days in the AI niche, sorted by reactions. Give me the hook, the author, and engagement for each.",
  },
  {
    tag: "Adapt",
    title: "Rewrite a viral post in your voice",
    prompt:
      "Find the single most viral post from the last 30 days. Pull its template. Rewrite it for me — I'm a B2B SaaS founder selling to mid-market RevOps leaders. Keep the hook structure, change the story to mine.",
  },
  {
    tag: "Plan",
    title: "Build a week of content",
    prompt:
      "Look at the top 20 viral posts from the last 14 days. Group them by hook pattern. Pick 5 patterns I haven't used yet and draft me a post for each one this week. Keep them under 1500 characters.",
  },
  {
    tag: "Steal",
    title: "Reverse-engineer a lead magnet",
    prompt:
      "Search the swipe file for lead-magnet posts (post_type = lead_magnet) from the last 30 days with more than 500 comments. For the top 3, tell me what they're giving away, the hook they used, and how I'd adapt the offer for my audience.",
  },
  {
    tag: "Manage",
    title: "Add a new creator to track",
    prompt:
      "Add linkedin.com/in/justinwelsh to my tracked accounts under niche 'solopreneur'. Then show me what other accounts I'm already tracking in that niche.",
  },
  {
    tag: "Analyze",
    title: "Find the patterns that work",
    prompt:
      "Look at every viral post from the last batch. What hook patterns show up most? Rank them by average engagement. Give me 3 hooks I should test this week based on what's pulling reactions right now.",
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
          <h1 className="text-4xl font-display tracking-tight">Claude</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Connect your swipe file to Claude via MCP. Then stop scrolling — just ask Claude what&apos;s
            working and have it draft, adapt, or analyze posts using your actual data.
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
            Paste this into Claude → Settings → Connectors → Add custom connector.
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
        <div className="flex items-end justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-xl font-semibold tracking-tight flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
              Example prompts
            </h2>
            <p className="text-sm text-muted-foreground">
              Copy any of these into Claude once the connector is live.
            </p>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {PROMPTS.map((p) => (
            <div
              key={p.title}
              className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card p-4 shadow-[0_1px_2px_0_rgba(15,23,42,0.04)]"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  {p.tag}
                </span>
                <CopyPrompt prompt={p.prompt} />
              </div>
              <div className="text-sm font-medium">{p.title}</div>
              <p className="text-[13px] leading-6 text-muted-foreground whitespace-pre-wrap">
                {p.prompt}
              </p>
            </div>
          ))}
        </div>
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
            ["list_accounts", "Your tracked creators, filterable by niche."],
            ["add_account", "Add a LinkedIn profile to track."],
            ["update_account", "Edit name or niche on a tracked account."],
            ["remove_account", "Soft-archive an account (history kept)."],
            ["restore_account", "Un-archive a previously removed account."],
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
