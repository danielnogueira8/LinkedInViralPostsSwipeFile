import { describe, expect, test } from "vitest";
import {
  GLOBAL_WRITING_SKILL,
  OUTPUT_LANGUAGE_RULE,
  POST_STRUCTURE_SKILL,
  SKILLS,
} from "@/lib/agent/skills";
import { AGENTS, composePrompt } from "@/app/(app)/dashboard/claude/agents";

// The Claude Workflows prompts are the moat: every copied prompt must CARRY
// the actual skill text the in-app agent injects (same source module), never
// a compressed summary. These pin the wiring so a refactor can't quietly
// ship the diluted version again.

describe("workflow prompts carry the full skill text", () => {
  test("every writing agent embeds the global anti-slop rules verbatim", () => {
    const writingAgents = AGENTS.filter((agent) =>
      agent.skills.includes("anti-slop"),
    );
    expect(writingAgents.length).toBeGreaterThan(0);
    for (const agent of writingAgents) {
      const prompt = composePrompt(agent.brief, agent.skills);
      expect(prompt).toContain(GLOBAL_WRITING_SKILL);
      expect(prompt).toContain(OUTPUT_LANGUAGE_RULE);
      // The brief leads; the rules follow under an explicit marker.
      expect(prompt.indexOf(agent.brief)).toBe(0);
      expect(prompt).toContain("WRITING RULES");
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

  test("read-only and logistics agents stay lean (no embedded rules)", () => {
    for (const slug of ["timing-strategist", "trend-radar", "roster-manager"]) {
      const agent = AGENTS.find((entry) => entry.slug === slug);
      expect(agent?.skills).toEqual([]);
      expect(composePrompt(agent!.brief, [])).toBe(agent!.brief);
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
});
