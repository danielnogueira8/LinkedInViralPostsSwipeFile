import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { CREATOR_CARD_GRID_CLASS } from "@/lib/discovery-display-policy";

describe("Creators loading skeleton", () => {
  test("uses the same creator-card grid contract as the loaded page", () => {
    const loading = readFileSync(
      "app/(app)/dashboard/accounts/loading.tsx",
      "utf8",
    );
    const picker = readFileSync(
      "app/(app)/dashboard/accounts/creator-picker.tsx",
      "utf8",
    );

    expect(picker).toContain('data-testid="creator-card-grid"');
    expect(loading).toContain('data-testid="creator-card-grid"');
    expect(picker).toContain("className={CREATOR_CARD_GRID_CLASS}");
    expect(loading).toContain("className={CREATOR_CARD_GRID_CLASS}");
    expect(CREATOR_CARD_GRID_CLASS).toBe("grid gap-4 lg:grid-cols-2");
    expect(loading).not.toContain("xl:grid-cols-5");
    expect(loading).toContain("Loading creators");
  });
});
