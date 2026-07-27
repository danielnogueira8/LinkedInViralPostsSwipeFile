import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

// Every surface that puts an icon next to a lead magnet. PR #1329 shipped the
// "WORKING NOW" chip with lucide-react's <Magnet />; these are the rest of the
// UI brought in line with it so one concept reads as one icon everywhere.
// (posts/drafts-list.tsx is deliberately NOT a site: the board card's Giveaway
// pill was removed — a giveaway forces the lead_magnet kind, so the kind badge
// alone carries the signal, with the resource name in its tooltip.)
const LEAD_MAGNET_ICON_SITES = [
  "app/(app)/dashboard/agent-briefing.tsx",
  "app/(app)/dashboard/chat-workspace.tsx",
  "app/(app)/dashboard/draft-editor-modal.tsx",
  "app/(app)/dashboard/lead-magnets/loading.tsx",
  "app/(app)/dashboard/nav-destinations.ts",
] as const;

const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("lead magnet iconography", () => {
  for (const site of LEAD_MAGNET_ICON_SITES) {
    describe(site, () => {
      const src = read(site);

      it("uses the Magnet icon", () => {
        expect(src).toMatch(/\bMagnet\b/);
      });

      it("does not use the old Gift icon", () => {
        // Catches both the import and any leftover <Gift ... /> render site.
        expect(src).not.toMatch(/\bGift(Icon)?\b/);
      });

      it("imports Magnet from lucide-react", () => {
        expect(src).toMatch(
          /import\s*\{[\s\S]*?\bMagnet\b[\s\S]*?\}\s*from\s*"lucide-react"/,
        );
      });
    });
  }

  it("keeps the nav entry for the Lead Magnets destination on Magnet", () => {
    const src = read("app/(app)/dashboard/nav-destinations.ts");
    expect(src).toMatch(/label:\s*"Lead Magnets"[^}]*icon:\s*Magnet/);
  });

  it("keeps the Working now badge from #1329 unchanged", () => {
    const src = read("app/(app)/dashboard/agent-briefing.tsx");
    expect(src).toContain('<Magnet className="h-3 w-3" aria-hidden />');
    expect(src).toContain('aria-label="Lead magnet post"');
  });
});
