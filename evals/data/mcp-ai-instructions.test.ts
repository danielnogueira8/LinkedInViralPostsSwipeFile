import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { PUBLIC_MCP_TOOLS } from "@/lib/mcp/public-tools";
import { SWIPEIN_MCP_INSTRUCTIONS } from "@/lib/mcp/llms-instructions";
import { GET } from "@/app/llms.txt/route";

describe("SwipeIn MCP instructions", () => {
  test("teach an AI how to use every published MCP tool", () => {
    for (const tool of PUBLIC_MCP_TOOLS) {
      expect(SWIPEIN_MCP_INSTRUCTIONS).toContain(`\`${tool.name}\``);
    }

    expect(SWIPEIN_MCP_INSTRUCTIONS).toContain("Read before you write");
    expect(SWIPEIN_MCP_INSTRUCTIONS).toContain("Never claim that a mutation succeeded");
    expect(SWIPEIN_MCP_INSTRUCTIONS).not.toContain("workspace_id=");
  });

  test("serves the canonical instructions publicly as llms.txt", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe(SWIPEIN_MCP_INSTRUCTIONS);

    const proxySource = readFileSync("proxy.ts", "utf8");
    expect(proxySource).toContain('"/llms.txt"');
  });

  test("offers one-click AI instructions from Claude Workflows", () => {
    const pageSource = readFileSync("app/(app)/dashboard/claude/page.tsx", "utf8");
    const copySource = readFileSync("app/(app)/dashboard/claude/copy.tsx", "utf8");

    expect(pageSource).toContain("SWIPEIN_MCP_INSTRUCTIONS");
    expect(pageSource).toContain("CopyAiInstructions");
    expect(copySource).toContain("Copy instructions for AI");

    const setupIndex = pageSource.indexOf("Setup — 4 steps");
    const instructionsIndex = pageSource.indexOf("Teach any AI to use SwipeIn correctly");
    const agentsIndex = pageSource.indexOf("Pick an Agent");
    expect(setupIndex).toBeLessThan(instructionsIndex);
    expect(instructionsIndex).toBeLessThan(agentsIndex);
  });
});
