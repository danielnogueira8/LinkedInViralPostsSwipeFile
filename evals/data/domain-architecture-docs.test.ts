import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("domain architecture documentation", () => {
  test("defines the product's canonical content language", () => {
    const context = read("CONTEXT.md");

    for (const term of [
      "Workspace",
      "Creator",
      "Source Post",
      "Bookmark",
      "Bookmark Share",
      "Model Source",
      "Cowork Turn",
      "Artifact",
      "Draft",
      "Lead Magnet",
    ]) {
      expect(context).toContain(`**${term}**:`);
    }
    expect(context).not.toMatch(/workspace_id|chat_artifacts|saved_posts|Supabase|Clerk/);
  });

  test("records the hard-to-reverse boundaries behind the current architecture", () => {
    const personalWorkspace = read(
      "docs/adr/0001-personal-workspace-tenancy.md",
    );
    const chatOwnership = read(
      "docs/adr/0002-canonical-chat-state-and-live-overlays.md",
    );
    const operations = read(
      "docs/adr/0003-shared-domain-operations-across-delivery-surfaces.md",
    );

    expect(personalWorkspace).toMatch(/personal workspace/i);
    expect(personalWorkspace).toMatch(/row-level security|RLS/i);
    expect(chatOwnership).toMatch(/persisted transcript/i);
    expect(chatOwnership).toMatch(/canonical chat state/i);
    expect(chatOwnership).toMatch(/separate Draft/i);
    expect(chatOwnership).toMatch(/stale/i);
    expect(operations).toMatch(/REST|MCP/);
    expect(operations).toMatch(/domain operation/i);
  });

  test("the README no longer describes organization-based tenancy", () => {
    const readme = read("README.md");

    expect(readme).not.toContain("Clerk (auth, multi-tenant orgs)");
    expect(readme).toContain("Clerk (personal-workspace auth)");
  });
});
