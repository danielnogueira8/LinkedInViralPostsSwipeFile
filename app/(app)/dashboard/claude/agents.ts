import type { ComponentType } from "react";
import {
  CalendarDays,
  Clock,
  Lightbulb,
  Magnet,
  Repeat2,
  Search,
  UserPlus,
} from "lucide-react";
import { AiIcon } from "@/components/ai-icon";
import {
  GLOBAL_WRITING_SKILL,
  OUTPUT_LANGUAGE_RULE,
  POST_STRUCTURE_SKILL,
  SKILLS,
} from "@/lib/agent/skills";

// Each workflow prompt CARRIES the actual skill text the in-app agent injects
// (same source module, so the two can never drift) — the copied prompt is the
// whole moat, not a one-line summary of it. The blocks append to the brief in
// the same order the agent applies them: language, anti-slop, structure, then
// task craft (hooks / lead-magnet / voice).
export function skillBody(id: string): string {
  const body = SKILLS.find((skill) => skill.id === id)?.body;
  if (!body) throw new Error(`Unknown skill: ${id}`);
  return body;
}

export const SKILL_CHIP_LABEL: Record<string, string> = {
  "anti-slop": "Anti-slop writing rules",
  structure: "Structure variety",
  hooks: "Hook craft",
  "voice-match": "Voice match",
  "lead-magnet": "Lead-magnet craft",
};

export function composePrompt(brief: string, skillIds: string[]): string {
  if (skillIds.length === 0) return brief;
  const blocks = [
    OUTPUT_LANGUAGE_RULE,
    ...(skillIds.includes("anti-slop") ? [GLOBAL_WRITING_SKILL] : []),
    ...(skillIds.includes("structure") ? [POST_STRUCTURE_SKILL] : []),
    ...skillIds
      .filter((id) => id !== "anti-slop" && id !== "structure")
      .map(skillBody),
  ];
  return `${brief}\n\n---\n\nWRITING RULES — follow these exactly, and apply them silently:\n\n${blocks.join("\n\n")}`;
}

// Workflows — copy-and-run agents. Each is framed as a named agent you put to
// work: the `tag` is the agent's name (rendered next to its avatar), the title
// is its concrete payoff, and `brief` is the task you hand it. Every brief
// opens with "Use the SwipeIn connector" so it reads naturally AND quietly
// reinforces the connector name from setup. `skills` lists the in-app agent
// skills embedded verbatim into the copied prompt via composePrompt above —
// the prompts are the moat, so they carry the full rule text, not a summary.
export type Agent = {
  tag: string; // the agent's name — rendered next to its avatar, e.g. "Batch Writer Agent"
  slug: string; // avatar file: public/agents/<slug>.svg (a <slug>.png overrides)
  title: string;
  payoff: string; // what you walk away with — the incentive
  brief: string;
  skills: string[]; // skill ids from lib/agent/skills embedded in the prompt
  icon: ComponentType<{ className?: string }>;
};

export const AGENTS: Agent[] = [
  {
    tag: "Bulk Writer Agent",
    slug: "bulk-writer",
    title: "10 posts, modeled on what's winning right now",
    payoff: "Walk away with 10 ready-to-edit posts in your voice — a full content pipeline in one run.",
    icon: AiIcon,
    skills: ["anti-slop", "structure", "hooks", "voice-match"],
    brief:
      "Use the SwipeIn connector. Call get_voice to load my writing voice. Then search_viral_posts for the 20 most viral regular posts from the last 7 days, pick the 10 with the most distinct structures, and write 10 posts modeled on them in my voice — no two using the same hook pattern, each under 1,500 characters. Save each one as a draft with create_draft, passing the modeled post's id as source_post_id.",
  },
  {
    tag: "Calendar Architect Agent",
    slug: "calendar-architect",
    title: "A full week of content, no two posts alike",
    payoff: "Get a 7-day calendar where every day uses a different proven hook pattern — no repeats, no blank-page mornings.",
    icon: CalendarDays,
    skills: ["anti-slop", "structure", "hooks", "voice-match"],
    brief:
      "Use the SwipeIn connector. Call get_voice first to load my writing voice. Then search_viral_posts for the top 20 viral posts from the last 14 days and group them by hook pattern. Build me a 7-day posting calendar — one post per day, each using a different pattern I haven't overused, drafted in my voice and under 1,500 characters. Save every post with create_draft (pass the modeled post's id as source_post_id for each) and schedule them across the week with schedule_draft.",
  },
  {
    tag: "Remix Agent",
    slug: "remix",
    title: "Turn one viral post into three angles",
    payoff: "One proven post becomes three distinct posts — same winning structure, three different stories you can space out.",
    icon: Repeat2,
    skills: ["anti-slop", "voice-match"],
    brief:
      "Use the SwipeIn connector. Call get_voice first to load my writing voice. Then find the single most viral post from the last 30 days, pull its structure with get_template, and write me 3 different posts that keep the hook structure but tell 3 different stories from my world. Match my voice, flag the part of each that's doing the heavy lifting, and save all three with create_draft, passing the source post's id as source_post_id.",
  },
  {
    tag: "Offer Hunter Agent",
    slug: "offer-hunter",
    title: "Reverse-engineer the best lead magnets",
    payoff: "See exactly what's being given away to drive 500+ comments — and get an adapted offer you can run this week.",
    icon: Magnet,
    skills: ["anti-slop", "lead-magnet", "voice-match"],
    brief:
      "Use the SwipeIn connector. search_viral_posts for lead-magnet posts (post_type = lead_magnet) from the last 30 days with more than 500 comments. For the top 3, tell me what they're giving away, the exact hook and CTA they used. Then call get_voice and write an adapted version of the best one for my audience, in my voice, and save it with create_draft.",
  },
  {
    tag: "Hook Scout Agent",
    slug: "hook-scout",
    title: "5 hooks to test, based on what's pulling now",
    payoff: "Skip the guesswork — get 5 hooks tied to patterns that are actually pulling engagement this week, ranked by why.",
    icon: Lightbulb,
    skills: ["anti-slop", "hooks", "voice-match"],
    brief:
      "Use the SwipeIn connector. Call get_voice first to load my writing voice. Then search_viral_posts for every viral post from the last 7 days and rank the hook patterns by average engagement. Give me the top 5 patterns and write one fresh hook for each in my voice, with a one-line note on why that pattern is working right now.",
  },
  {
    tag: "Timing Strategist Agent",
    slug: "timing-strategist",
    title: "Schedule around when big posts actually land",
    payoff: "Stop guessing post times — get the day-and-hour windows where the creators you track land their biggest hits.",
    icon: Clock,
    skills: [],
    brief:
      "Use the SwipeIn connector. Across the viral posts from the last 30 days, tell me which days of the week and times of day produce the most viral posts for the creators I track. Then list_drafts, pick my 5 strongest, and schedule them into those windows with schedule_draft.",
  },
  {
    tag: "Trend Radar Agent",
    slug: "trend-radar",
    title: "See this week's best posts at a glance",
    payoff: "A fast read on what's working in your niche right now — hooks, authors, and engagement, ranked.",
    icon: Search,
    skills: [],
    brief:
      "Use the SwipeIn connector. search_viral_posts for the top 10 viral posts from the last 7 days in my niche, sorted by reactions. Give me the hook, the author, and engagement for each so I can see what's working at a glance.",
  },
  {
    tag: "Roster Manager Agent",
    slug: "roster-manager",
    title: "Add a creator to track",
    payoff: "Grow your swipe file in one line — add a creator and instantly see who else you track in their niche.",
    icon: UserPlus,
    skills: [],
    brief:
      "Use the SwipeIn connector. add_account for linkedin.com/in/justinwelsh under niche 'solopreneur'. Then show me what other accounts I'm already tracking in that niche.",
  },
];

