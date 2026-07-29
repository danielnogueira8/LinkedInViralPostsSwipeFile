import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const modal = fs.readFileSync(
  path.join(process.cwd(), "app/(app)/dashboard/draft-editor-modal.tsx"),
  "utf8",
);

describe("Post settings giveaway picker", () => {
  test("caps both giveaway triggers to the property value column", () => {
    const giveawayRows = [
      ...modal.matchAll(
        /<PropRow icon=\{<Magnet className="h-4 w-4" \/>\} label="Giveaway">([\s\S]*?)<\/PropRow>/g,
      ),
    ];

    expect(giveawayRows).toHaveLength(2);
    for (const [, row] of giveawayRows) {
      expect(row).toMatch(
        /<SelectTrigger[\s\S]*?className="[^"]*\bmax-w-full\b[^"]*"[\s\S]*?aria-label="Giveaway"/,
      );
    }
  });
});
