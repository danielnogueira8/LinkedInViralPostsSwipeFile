import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  isGlobalBaselineCreator,
  normalizeCreatorHandle,
  rankDiscoveryCreators,
  selectStarterPack,
  type DiscoveryCreator,
} from "@/lib/creator-discovery";

const creator = (
  overrides: Partial<DiscoveryCreator> = {},
): DiscoveryCreator => ({
  id: "creator-1",
  name: "Grace Andrews",
  linkedinHandle: "grace-andrews1",
  headline: "Builds modern creator brands",
  recommendationReason: "Practical creator-economy playbooks",
  discoveryTags: ["creator economy", "personal brand"],
  categoryId: "creator-economy",
  source: "sheet",
  manualOwnerWorkspaceId: null,
  isFeatured: true,
  totalPostCount: 20,
  topReactions: 700,
  ...overrides,
});

describe("creator discovery catalog", () => {
  test("normalizes profile URLs and handles to one lowercase key", () => {
    expect(normalizeCreatorHandle(" https://www.linkedin.com/in/Grace-Andrews1/?trk=feed ")).toBe(
      "grace-andrews1",
    );
    expect(normalizeCreatorHandle("@Grace-Andrews1")).toBe("grace-andrews1");
  });

  test("treats only app-owned rows as global baseline creators", () => {
    expect(isGlobalBaselineCreator(creator())).toBe(true);
    expect(
      isGlobalBaselineCreator(
        creator({ source: "manual", manualOwnerWorkspaceId: "workspace-a" }),
      ),
    ).toBe(false);
    expect(
      isGlobalBaselineCreator(
        creator({ source: "sheet", manualOwnerWorkspaceId: "workspace-a" }),
      ),
    ).toBe(false);
  });

  test("searches recommendation context and sorts deterministic best matches", () => {
    const rows = [
      creator({ id: "a", isFeatured: false, totalPostCount: 100 }),
      creator({
        id: "b",
        name: "Cameron Poole",
        linkedinHandle: "trajectory-sales",
        headline: "Outbound sales systems",
        recommendationReason: "Clear pipeline advice",
        discoveryTags: ["sales", "outreach"],
        categoryId: "outreach",
        totalPostCount: 5,
      }),
    ];

    expect(
      rankDiscoveryCreators(rows, { query: "pipeline", sort: "best-match" }).map(
        (row) => row.id,
      ),
    ).toEqual(["b"]);
  });

  test("builds a balanced pack from global creators in selected topics", () => {
    const rows = [
      creator({ id: "a1", categoryId: "ai" }),
      creator({ id: "a2", categoryId: "ai", isFeatured: false }),
      creator({ id: "g1", categoryId: "gtm" }),
      creator({ id: "g2", categoryId: "gtm", isFeatured: false }),
      creator({
        id: "private",
        categoryId: "gtm",
        source: "manual",
        manualOwnerWorkspaceId: "workspace-a",
      }),
    ];

    const pack = selectStarterPack(rows, {
      categoryIds: ["ai", "gtm"],
      limit: 4,
    });

    expect(pack.map((row) => row.id)).toEqual(["a1", "g1", "a2", "g2"]);
    expect(pack.some((row) => row.id === "private")).toBe(false);
  });

  test("migration seeds baseline ownership and prevents normalized-handle duplicates", () => {
    const sql = readFileSync("db/migration-089-content-source-discovery.sql", "utf8");
    expect(sql).toMatch(/manual_owner_workspace_id\s*=\s*null/i);
    expect(sql).toMatch(/accounts_linkedin_handle_ci_unique/i);
    expect(sql).toMatch(/founders-startups/);
    expect(sql).toMatch(/creator-economy/);
    expect(sql).toMatch(/recommendation_reason\s*=\s*coalesce/i);
    expect(sql).toContain("A proven creator with posts already available to study.");
    expect(sql).toMatch(/on conflict \(workspace_id, account_id\) do update set/i);
    expect(sql).not.toMatch(/delete from categories c/i);
    expect(sql).toMatch(/values\s*\(\s*true\s*,\s*89\s*,/i);
  });
});
