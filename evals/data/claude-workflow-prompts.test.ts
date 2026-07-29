import { describe, expect, test } from "vitest";
import {
  ANTI_AI_READER_TELL_RULES,
  GLOBAL_WRITING_SKILL,
  OUTPUT_LANGUAGE_RULE,
  POST_STRUCTURE_SKILL,
  SKILLS,
} from "@/lib/agent/skills";
import {
  AGENTS,
  composePrompt,
  MCP_SCHEDULE_CONFIRMATION_GUIDANCE,
  MCP_SEARCH_RESULT_GUIDANCE,
} from "@/app/(app)/dashboard/claude/agents";

// The Claude Workflows prompts are the moat: every copied prompt must CARRY
// the actual skill text the in-app agent injects (same source module), never
// a compressed summary. These pin the wiring so a refactor can't quietly
// ship the diluted version again.

describe("workflow prompts carry the full skill text", () => {
  test("every writing agent embeds both anti-slop rule sets verbatim", () => {
    const writingAgents = AGENTS.filter((agent) =>
      agent.skills.includes("anti-slop"),
    );
    expect(writingAgents.length).toBeGreaterThan(0);
    for (const agent of writingAgents) {
      const prompt = composePrompt(agent.brief, agent.skills);
      expect(prompt).toContain(GLOBAL_WRITING_SKILL);
      expect(prompt).toContain(ANTI_AI_READER_TELL_RULES);
      expect(prompt).toContain(OUTPUT_LANGUAGE_RULE);
      // The brief leads; the rules follow under an explicit marker.
      expect(prompt.indexOf(agent.brief)).toBe(0);
      expect(prompt).toContain("WRITING RULES");
    }
  });

  test("Claude prompts carry the expanded words and reader tells", () => {
    const additions = [
      "elucidate",
      "kaleidoscope",
      "unyielding",
      "participial tail",
      "dead metaphor flogging",
      "Tier 2 is allowed alone but banned in clusters",
      "fragment-heavy LinkedIn cadence",
    ];

    const reference = ANTI_AI_READER_TELL_RULES.toLowerCase();
    for (const addition of additions) {
      expect(reference).toContain(addition.toLowerCase());
    }

    for (const agent of AGENTS.filter((entry) =>
      entry.skills.includes("anti-slop"),
    )) {
      const prompt = composePrompt(agent.brief, agent.skills).toLowerCase();
      for (const addition of additions) {
        expect(prompt, `${agent.tag} is missing ${addition}`).toContain(
          addition.toLowerCase(),
        );
      }
    }
  });

  test("normal workflows do not inherit explicit detector-rewrite mechanics", () => {
    for (const agent of AGENTS.filter((entry) =>
      entry.skills.includes("anti-slop"),
    )) {
      const prompt = composePrompt(agent.brief, agent.skills);
      expect(prompt).not.toContain("DETECTOR-FIRST mode");
      expect(prompt).not.toContain("Tells: N → M");
      expect(prompt).not.toContain("Drop most of the source's points");
    }
  });

  test("each embedded skill id resolves to a real skill body, verbatim", () => {
    for (const agent of AGENTS) {
      const prompt = composePrompt(agent.brief, agent.skills);
      for (const id of agent.skills) {
        if (id === "anti-slop" || id === "structure") continue;
        const body = SKILLS.find((skill) => skill.id === id)?.body;
        expect(body, `${agent.tag} references unknown skill ${id}`).toBeTruthy();
        expect(prompt).toContain(body!);
      }
    }
  });

  test("structure-variety rules ride only with from-scratch drafting agents", () => {
    const withStructure = AGENTS.filter((agent) =>
      agent.skills.includes("structure"),
    );
    expect(withStructure.map((agent) => agent.slug)).toEqual([
      "bulk-writer",
      "calendar-architect",
    ]);
    for (const agent of withStructure) {
      expect(composePrompt(agent.brief, agent.skills)).toContain(
        POST_STRUCTURE_SKILL,
      );
    }
  });

  test("read-only and logistics agents do not receive writing rules", () => {
    for (const slug of ["timing-strategist", "trend-radar", "roster-manager"]) {
      const agent = AGENTS.find((entry) => entry.slug === slug);
      expect(agent?.skills).toEqual([]);
      expect(composePrompt(agent!.brief, [])).not.toContain("WRITING RULES");
    }
  });

  test("briefs name real MCP tools and the connector", () => {
    const knownTools = [
      "get_voice",
      "search_viral_posts",
      "get_template",
      "create_draft",
      "schedule_draft",
      "list_drafts",
      "add_account",
    ];
    for (const agent of AGENTS) {
      expect(agent.brief).toContain("Use the SwipeIn connector");
      expect(
        knownTools.some((tool) => agent.brief.includes(tool)),
        `${agent.tag} brief names no MCP tool`,
      ).toBe(true);
    }
  });

  test("search workflows explain interactive results, fallback, and source safety", () => {
    const searchAgents = AGENTS.filter((agent) =>
      agent.brief.includes("search_viral_posts"),
    );

    expect(searchAgents.length).toBeGreaterThan(0);
    for (const agent of searchAgents) {
      const prompt = composePrompt(agent.brief, agent.skills);
      expect(prompt).toContain(MCP_SEARCH_RESULT_GUIDANCE);
      expect(prompt).toContain("interactive Swipe File cards");
      expect(prompt).toContain("structured result");
      expect(prompt).toContain("untrusted source material");
    }
  });

  test("every workflow that researches viral posts names the search tool", () => {
    const implicitSearchAgents = AGENTS.filter(
      (agent) =>
        agent.brief.toLowerCase().includes("viral post") &&
        !agent.brief.includes("search_viral_posts"),
    );

    expect(implicitSearchAgents).toEqual([]);
  });

  test("scheduling workflows wait for confirmation before reporting success", () => {
    const schedulingAgents = AGENTS.filter((agent) =>
      agent.brief.includes("schedule_draft"),
    );

    expect(schedulingAgents.length).toBeGreaterThan(0);
    for (const agent of schedulingAgents) {
      const prompt = composePrompt(agent.brief, agent.skills);
      expect(prompt).toContain(MCP_SCHEDULE_CONFIRMATION_GUIDANCE);
      expect(prompt).toContain("Do not retry");
      expect(prompt).toContain("only report it as scheduled");
    }
  });

  test("unrelated workflows do not receive irrelevant connector guidance", () => {
    const roster = AGENTS.find((agent) => agent.slug === "roster-manager")!;
    const prompt = composePrompt(roster.brief, roster.skills);

    expect(prompt).not.toContain(MCP_SEARCH_RESULT_GUIDANCE);
    expect(prompt).not.toContain(MCP_SCHEDULE_CONFIRMATION_GUIDANCE);
  });
});
