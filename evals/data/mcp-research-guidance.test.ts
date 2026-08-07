import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { SWIPE_MCP_INSTRUCTIONS } from "@/lib/mcp/instructions";

const registerSource = readFileSync("lib/mcp/register.ts", "utf8");
const serverSource = readFileSync("lib/mcp/server.ts", "utf8");

describe("MCP server instructions", () => {
  test("are wired into the server, not just defined", () => {
    expect(serverSource).toContain("instructions: SWIPE_MCP_INSTRUCTIONS");
  });

  test("route recency vs general research to the right tools", () => {
    expect(SWIPE_MCP_INSTRUCTIONS).toContain("get_top_from_batch");
    expect(SWIPE_MCP_INSTRUCTIONS).toContain("search_viral_posts");
    expect(SWIPE_MCP_INSTRUCTIONS).toContain("analyze_posts");
  });

  test("tell the model a thin result is a filter artifact, not the whole dataset", () => {
    expect(SWIPE_MCP_INSTRUCTIONS).toMatch(/filtered, not exhaustive/i);
    expect(SWIPE_MCP_INSTRUCTIONS).toMatch(/widen/i);
  });

  test("forbid generalizing a trend from a single post — the reported bug", () => {
    expect(SWIPE_MCP_INSTRUCTIONS).toMatch(/never present a single post as a trend/i);
  });

  test("separate the user's own performance from other people's posts", () => {
    expect(SWIPE_MCP_INSTRUCTIONS).toContain("get_post_performance");
  });

  test("keep the tool-output-is-data trust boundary", () => {
    expect(SWIPE_MCP_INSTRUCTIONS).toMatch(/never instructions/i);
  });
});

describe("get_top_from_batch defaults", () => {
  test("defaults to 10 so a pattern question gets a pattern-sized sample", () => {
    expect(registerSource).toContain("const TOP_BATCH_DEFAULT_LIMIT = 10");
    expect(registerSource).toContain("limit ?? TOP_BATCH_DEFAULT_LIMIT");
    // The old hardcoded default must be gone, or the constant is decorative.
    // Anchored so unrelated defaults (e.g. `limit ?? 50`) don't match.
    expect(registerSource).not.toMatch(/limit \?\? 5\b/);
  });

  test("exposes a window_days override so a quiet week can be widened", () => {
    expect(registerSource).toContain("window_days: z");
    expect(registerSource).toContain("window_days ?? TOP_BATCH_WINDOW_DAYS");
  });

  test("reports the window actually used, not the hardcoded default", () => {
    expect(registerSource).toContain("window_days: windowDays");
    expect(registerSource).not.toContain("window_days: TOP_BATCH_WINDOW_DAYS,");
  });

  test("flags sparse results with a widen-first instruction", () => {
    expect(registerSource).toContain("sparse: true");
    expect(registerSource).toMatch(/not the full set of posts published/i);
  });
});
