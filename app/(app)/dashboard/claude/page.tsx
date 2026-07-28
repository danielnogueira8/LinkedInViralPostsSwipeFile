import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { PageHeader } from "@/components/app-surface";
import {
  Plug,
  Shield,
  Check,
  BookOpenText,
  ExternalLink,
} from "lucide-react";
import { AgentAvatar } from "@/components/agent-avatar";
import Image from "next/image";
import { CopyAiInstructions, CopyConnectorUrl, CopyPrompt } from "./copy";
import { requireWorkspaceId } from "@/lib/workspace";
import { PUBLIC_MCP_TOOLS } from "@/lib/mcp/public-tools";
import { SWIPEIN_MCP_INSTRUCTIONS } from "@/lib/mcp/llms-instructions";
import { AGENTS, composePrompt, SKILL_CHIP_LABEL } from "./agents";

// The apex domain 307-redirects to www; MCP clients don't follow redirects on
// the initialize POST, so the connector URL must be the canonical www host.
const CONNECTOR_URL_BASE = "https://www.tryswipein.com/api/mcp";

export default async function ClaudePage() {
  const workspaceId = await requireWorkspaceId();
  const connectorUrl = `${CONNECTOR_URL_BASE}?workspace_id=${encodeURIComponent(workspaceId)}`;

  return (
    <div className="space-y-8">
      <PageHeader
        meta={
          <span className="grid h-9 w-9 place-items-center rounded-lg border border-border/60 bg-muted">
            {/* The colored Claude mark, same as the landing features grid. */}
            <Image src="/claude.svg" alt="" width={20} height={20} />
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
          {/* One-time setup, about a minute — everything you need is on this card. */}
          <ol className="mt-4 space-y-3 border-t border-border/60 pt-4">
            {(
              [
                [
                  "Paste it in and name it SwipeIn",
                  <>
                    Drop the URL above into the{" "}
                    <span className="font-medium text-foreground">MCP server URL</span> field and name
                    the connector{" "}
                    <span className="font-medium text-foreground">SwipeIn</span> — every prompt below
                    references it by that name. Leave the Advanced fields (Client ID / Secret) empty;
                    Claude handles registration automatically.
                  </>,
                ],
                [
                  "Sign in with your Swipe File email",
                  <>
                    Claude opens a sign-in screen. Use the{" "}
                    <span className="font-medium text-foreground">same email you use here</span> — the
                    connector is locked to allow-listed accounts.
                  </>,
                ],
                [
                  "Run a workflow",
                  <>
                    Open any chat and <span className="font-medium text-foreground">SwipeIn</span>{" "}
                    shows up as a tool source. Copy one of the agents below and paste it in.
                  </>,
                ],
              ] as const
            ).map(([title, body], i) => (
              <li key={title} className="flex items-start gap-3">
                <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-foreground text-[10px] font-medium text-background">
                  {i + 1}
                </span>
                <span className="text-[13px] leading-5 text-muted-foreground">
                  <span className="font-medium text-foreground">{title}.</span> {body}
                </span>
              </li>
            ))}
          </ol>
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
          <h2 className="text-xl font-semibold tracking-tight">Pick an Agent</h2>
          <p className="text-sm text-muted-foreground">
            Each agent is a ready-made prompt — copy it into any Claude chat where the SwipeIn
            connector is on, then put it to work. Tweak the niche, voice, or count to taste.
          </p>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          {AGENTS.map((agent) => {
            const Icon = agent.icon;
            const prompt = composePrompt(agent.brief, agent.skills);
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
                    <CopyPrompt prompt={prompt} />
                  </div>
                  <p className="max-h-48 overflow-y-auto whitespace-pre-wrap pr-1 text-[13px] leading-6 text-muted-foreground">
                    {prompt}
                  </p>
                  {agent.skills.length > 0 ? (
                    <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-border/60 pt-2">
                      <span className="text-[9px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                        Carries
                      </span>
                      {agent.skills.map((skillId) => (
                        <span
                          key={skillId}
                          className="rounded-full bg-background px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground"
                        >
                          {SKILL_CHIP_LABEL[skillId] ?? skillId}
                        </span>
                      ))}
                    </div>
                  ) : null}
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
