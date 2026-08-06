import { describe, expect, test, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({ from: () => ({}) }),
}));

vi.mock("@/lib/supabase-scoped", () => ({
  trackedAccountIds: async () => [],
}));

const { PUBLIC_MCP_TOOLS } = await import("@/lib/mcp/public-tools");
const { registerSwipeTools } = await import("@/lib/mcp/register");

const EXPECTED_PUBLIC_TOOLS = [
  "search_viral_posts",
  "get_post",
  "list_niches",
  "get_top_from_batch",
  "get_post_performance",
  "list_accounts",
  "add_account",
  "update_account",
  "remove_account",
  "restore_account",
  "list_drafts",
  "get_draft",
  "create_draft",
  "schedule_draft",
  "unschedule_draft",
  "get_voice",
  "create_voice",
  "list_preferences",
  "create_preference",
  "save_post",
  "list_saved_posts",
  "list_categories",
  "create_category",
  "list_templates",
  "get_template",
  "create_template",
  "list_skills",
  "get_skill",
  "create_skill",
  "list_creator_styles",
  "get_creator_style",
  "create_creator_style",
  "list_lead_magnets",
  "get_lead_magnet",
  "create_lead_magnet",
] as const;

describe("public MCP contract", () => {
  test("registers every public tool and publishes the same catalog to Claude Workflows", () => {
    const registered: string[] = [];
    registerSwipeTools({
      registerTool: (name: string) => registered.push(name),
    } as never);

    expect(registered.sort()).toEqual([...EXPECTED_PUBLIC_TOOLS].sort());
    expect(PUBLIC_MCP_TOOLS.map((tool) => tool.name).sort()).toEqual(
      [...EXPECTED_PUBLIC_TOOLS].sort(),
    );
  });

  test("has unique names and user-facing descriptions", () => {
    expect(new Set(PUBLIC_MCP_TOOLS.map((tool) => tool.name)).size).toBe(
      PUBLIC_MCP_TOOLS.length,
    );
    for (const tool of PUBLIC_MCP_TOOLS) {
      expect(tool.description.trim().length).toBeGreaterThan(10);
    }
  });

  test("advertises interactive discovery and confirmed scheduling semantics", () => {
    const registered = new Map<string, { description?: string }>();
    registerSwipeTools({
      registerTool: (
        name: string,
        config: { description?: string },
      ) => registered.set(name, config),
    } as never);
    const search = PUBLIC_MCP_TOOLS.find(
      (tool) => tool.name === "search_viral_posts",
    );
    const schedule = PUBLIC_MCP_TOOLS.find(
      (tool) => tool.name === "schedule_draft",
    );

    expect(search?.description).toContain("interactive Swipe File");
    expect(search?.description).toContain("structured");
    expect(schedule?.description).toContain("confirmation");
    expect(schedule?.description).toContain("unchanged");
    expect(registered.get("search_viral_posts")?.description).toContain(
      "interactive Swipe File",
    );
    expect(registered.get("schedule_draft")?.description).toContain(
      "confirmation",
    );
  });
});
