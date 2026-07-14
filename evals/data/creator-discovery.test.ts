import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  isGlobalBaselineCreator,
  normalizeCreatorHandle,
  rankDiscoveryCreators,
  selectDisplayDiscoveryTags,
  selectStarterPack,
  type DiscoveryCreator,
} from "@/lib/creator-discovery";
import {
  getCreatorDisplayWindow,
  getStarterPackTrackingSummary,
} from "@/lib/discovery-display-policy";

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
  test("uses one creator vocabulary and one card grid in both tabs", () => {
    const picker = readFileSync(
      "app/(app)/dashboard/accounts/creator-picker.tsx",
      "utf8",
    );
    const page = readFileSync("app/(app)/dashboard/accounts/page.tsx", "utf8");

    expect(picker).toContain("My creators");
    expect(picker).toContain("Filter your creators");
    expect(picker).toContain('label="All creators"');
    expect(picker).toContain('data-testid="creator-card-grid"');
    expect(picker).not.toMatch(/My sources|Filter your sources|All sources|Search your sources/);
    expect(page).toContain('title="Creators"');
    expect(page).not.toContain('title="Content Sources"');
  });

  test("shows only distinct discovery tags that add context beyond the category", () => {
    expect(
      selectDisplayDiscoveryTags(
        [
          "linkedin & personal brand",
          "founder-led growth",
          "Founder-led growth",
          "content systems",
        ],
        "LinkedIn/Personal Brand",
        3,
      ),
    ).toEqual(["founder-led growth", "content systems"]);
  });

  test("shows a focused creator shortlist and reveals one useful batch at a time", () => {
    expect(getCreatorDisplayWindow(104, 12, 12)).toEqual({
      visibleCount: 12,
      remainingCount: 92,
      nextCount: 12,
    });
    expect(getCreatorDisplayWindow(17, 12, 12)).toEqual({
      visibleCount: 12,
      remainingCount: 5,
      nextCount: 5,
    });
    expect(getCreatorDisplayWindow(8, 12, 12)).toEqual({
      visibleCount: 8,
      remainingCount: 0,
      nextCount: 0,
    });
  });

  test("explains how much of a starter pack is already tracked", () => {
    expect(getStarterPackTrackingSummary(8, 6)).toEqual({
      alreadyTrackedCount: 2,
      untrackedCount: 6,
      detail: "8 total · 2 already tracked · 6 to add",
      actionLabel: "Track 6 creators",
    });
    expect(getStarterPackTrackingSummary(8, 8).detail).toBe(
      "8 total · 0 already tracked · 8 to add",
    );
    expect(getStarterPackTrackingSummary(8, 0)).toEqual({
      alreadyTrackedCount: 8,
      untrackedCount: 0,
      detail: "8 total · 8 already tracked · 0 to add",
      actionLabel: "Pack is tracked",
    });
  });

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

  test("migration establishes manual ownership before using it", () => {
    const sql = readFileSync("db/migration-089-content-source-discovery.sql", "utf8");
    const columnDeclaration = sql.indexOf(
      "add column if not exists manual_owner_workspace_id text",
    );
    const firstColumnUse = sql.indexOf("manual_owner_workspace_id is null");

    expect(columnDeclaration).toBeGreaterThan(-1);
    expect(firstColumnUse).toBeGreaterThan(columnDeclaration);
    expect(sql.indexOf("with sole_owners as")).toBeGreaterThan(columnDeclaration);
    expect(sql.indexOf("with sole_owners as")).toBeLessThan(firstColumnUse);
  });

  test("migration does not rely on cross-statement temporary tables", () => {
    const sql = readFileSync("db/migration-089-content-source-discovery.sql", "utf8");

    expect(sql).not.toMatch(/create\s+temporary\s+table/i);
    expect(sql).not.toMatch(/on\s+commit\s+drop/i);
  });
});
