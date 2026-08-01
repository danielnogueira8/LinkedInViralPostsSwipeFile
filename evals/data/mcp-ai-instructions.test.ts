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

  test("explains interactive search results and their safe text fallback", () => {
    expect(SWIPEIN_MCP_INSTRUCTIONS).toContain(
      "interactive Swipe File cards",
    );
    expect(SWIPEIN_MCP_INSTRUCTIONS).toContain("structured result");
    expect(SWIPEIN_MCP_INSTRUCTIONS).toContain(
      "Never claim that an interactive view rendered",
    );
    expect(SWIPEIN_MCP_INSTRUCTIONS).toContain(
      "Do not repeat every full post body",
    );
  });

  test("explains the confirmed scheduling round trip", () => {
    expect(SWIPEIN_MCP_INSTRUCTIONS).toContain(
      "requires explicit user confirmation",
    );
    expect(SWIPEIN_MCP_INSTRUCTIONS).toContain(
      "Do not retry while confirmation is pending",
    );
    expect(SWIPEIN_MCP_INSTRUCTIONS).toContain(
      "A declined or cancelled confirmation leaves the draft unchanged",
    );
  });

  test("starts a pasted instruction-only chat by verifying SwipeIn and offering choices", () => {
    expect(SWIPEIN_MCP_INSTRUCTIONS).toContain(
      "When these instructions are pasted without a specific task",
    );
    expect(SWIPEIN_MCP_INSTRUCTIONS).toContain("call `list_niches`");
    expect(SWIPEIN_MCP_INSTRUCTIONS).toContain("Do not reply with only");
    expect(SWIPEIN_MCP_INSTRUCTIONS).toContain("Find viral posts in my niche");
    expect(SWIPEIN_MCP_INSTRUCTIONS).toContain("Write a post in my voice");
    expect(SWIPEIN_MCP_INSTRUCTIONS).toContain("Work with my drafts");
    expect(SWIPEIN_MCP_INSTRUCTIONS).toContain("Manage the creators I track");
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
    expect(pageSource).toContain("The AI will verify the SwipeIn connector");
    expect(copySource).toContain("Copy instructions for AI");
  });
});
