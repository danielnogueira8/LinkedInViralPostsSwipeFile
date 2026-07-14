import type { PlanStep } from "@/lib/agent/contracts";
import type { Message, ToolChip } from "@/lib/chat-hydration";

export function shouldShowActivityRail(
  plan: PlanStep[],
  tools: ToolChip[],
): boolean {
  if (tools.length === 0) return false;
  if (plan.length === 0) return true;
  return tools.some((t) => t.ok === false);
}

export function planProgressTitle(
  plan: PlanStep[],
  liveStatus: string | null,
): string {
  if (liveStatus) return liveStatus;
  return plan.length > 0 && plan.every((step) => step.status === "done")
    ? "Plan complete"
    : "Working";
}

export function prettyToolName(name: string): string {
  return name.replace(/_/g, " ");
}

// ----- agent activity narration -----
//
// The backend streams tool_start with the tool NAME and its ARGS (a JSON
// string). Rather than render a bare chip ("search_viral_posts"), we narrate
// each step the way the agent would describe it — a present-tense verb phrase
// while running ("Searching the swipe file · AI"), flipped to past tense once
// the tool finishes ("Searched the swipe file · AI"). The args are parsed
// defensively (a half-streamed tool_start can carry truncated JSON) and only a
// couple of human-meaningful params are surfaced as a trailing detail; the rest
// (limits, internal flags) stay hidden, matching the system prompt's "never
// narrate internal tool mechanics" rule.

type ToolPhrase = { running: string; done: string };

// Per-tool verb phrases. Keyed by the tool names defined in lib/agent/tools.ts.
const TOOL_PHRASES: Record<string, ToolPhrase> = {
  search_viral_posts: {
    running: "Searching the swipe file",
    done: "Searched the swipe file",
  },
  get_post: { running: "Reading a post", done: "Read a post" },
  list_niches: {
    running: "Checking your niches",
    done: "Checked your niches",
  },
  get_top_from_batch: {
    running: "Pulling the latest top posts",
    done: "Pulled the latest top posts",
  },
  get_voice: {
    running: "Reading your voice profile",
    done: "Read your voice profile",
  },
  list_accounts: {
    running: "Looking up tracked creators",
    done: "Looked up tracked creators",
  },
  search_news: { running: "Searching the news", done: "Searched the news" },
  // Board tools — the agent operating the user's drafts pipeline.
  list_drafts: { running: "Checking your drafts", done: "Checked your drafts" },
  move_on_board: { running: "Updating your board", done: "Updated your board" },
  schedule_post: { running: "Scheduling on your board", done: "Scheduled on your board" },
  generate_lead_magnet_image: {
    running: "Adapting the source image",
    done: "Adapted the source image",
  },
};

export function toolPhrase(name: string, completed: boolean): string {
  const phrase = TOOL_PHRASES[name];
  return (completed ? phrase?.done : phrase?.running) ?? prettyToolName(name);
}

// Parse tool args (best-effort) and return a short human detail to append after
// the verb phrase, or "" when there's nothing worth showing. We deliberately
// surface only audience-meaningful params (niche, the modeled post, a brand or
// account name) — never limits, sort keys, or internal flags.
export function toolDetail(name: string, argsJson: string): string {
  let args: Record<string, unknown>;
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    return ""; // truncated/streaming JSON — no detail yet
  }
  const pick = (k: string): string | null => {
    const v = args[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  if (name === "search_viral_posts") {
    const niche = pick("niche");
    const type = pick("post_type");
    return [niche, type === "lead_magnet" ? "lead magnets" : null]
      .filter(Boolean)
      .join(" · ");
  }
  if (name === "list_accounts") return pick("niche") ?? "";
  if (name === "generate_lead_magnet_image") return pick("leadMagnet") ?? "";
  return "";
}

// The label of an in-flight agent run, shown above the activity stream while it
// works (the reference app's "Planning next moves"). GLM doesn't stream a
// separate reasoning channel, so we derive an honest cue from run state.
//
// The cue is shown for the ENTIRE streaming turn and only disappears when the
// turn is fully done (streaming flips false). A non-empty message.text does NOT
// mean "done" — the agent commonly streams an opening line, THEN calls tools,
// THEN streams the answer, with think-gaps in between. Going silent on the
// first token (the old behavior) left those gaps with no cue, so it looked
// frozen mid-turn (e.g. after "I'll pull your voice profile…" but before the
// tool chip appears).
export function agentStatus(message: Message): string | null {
  if (!message.streaming) return null;
  const tools = message.tools ?? [];
  const running = tools.find((t) => t.ok === undefined);
  if (running) {
    return TOOL_PHRASES[running.name]?.running ?? "Working";
  }
  // No tool currently running: "Planning next moves" before anything has
  // happened, then a steady "Working" through every later gap (between tool
  // rounds, while composing the final answer) so the cue never drops.
  const hasActivity = !!message.text || tools.length > 0;
  return hasActivity ? "Working" : "Planning next moves";
}

// Once the last real tool settles, the model still has work to do before the
// turn is finished. Keep that phase visible as a new spinner row instead of
// leaving a rail full of green checks under a generic "Working" header. Tool
// history alone cannot reveal whether the user requested ideas, analysis, or a
// post, so the pre-deliverable label deliberately stays intent-neutral.
export function activityTailLabel(
  tools: ToolChip[],
  liveStatus: string | null,
  draftRendered = false,
): string | null {
  if (!liveStatus || tools.length === 0) return null;
  if (tools.some((tool) => tool.ok === undefined)) return null;
  if (draftRendered) return "Saving your draft";

  return "Preparing your response";
}

const INTERNAL_RENDER_TOOLS = new Set([
  "render_post",
  "render_hook",
  "render_cite",
]);

// Once the server has produced the draft artifact, rendering/citation tools are
// internal persistence work rather than useful progress steps. Hide only those
// mechanics; completed research and genuinely user-visible follow-on work stay
// in the rail while the canonical persisted draft is loading into the panel.
export function visibleActivityTools(
  tools: ToolChip[],
  draftRendered: boolean,
): ToolChip[] {
  return draftRendered
    ? tools.filter((tool) => !INTERNAL_RENDER_TOOLS.has(tool.name))
    : tools;
}
