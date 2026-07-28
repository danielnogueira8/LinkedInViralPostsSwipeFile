import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const widget = fs.readFileSync(
  path.join(
    process.cwd(),
    "app/(app)/dashboard/posts/posting-queue-widget.tsx",
  ),
  "utf8",
);

describe("posting queue settings panel", () => {
  test("places the settings action immediately before the collapse toggle", () => {
    const settings = widget.indexOf('aria-label="Queue settings"');
    const collapse = widget.indexOf(
      'aria-label={`Posting queue, ${collapsed ? "expand" : "collapse"}`}',
    );
    expect(settings).toBeGreaterThan(-1);
    expect(collapse).toBeGreaterThan(settings);
  });

  test("opens an accessible right-side panel with all seven days", () => {
    expect(widget).toContain("<DialogTitle>Posting queue settings</DialogTitle>");
    expect(widget).toContain(
      "left-auto right-0 top-0 h-dvh max-h-dvh",
    );
    for (const day of [
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ]) {
      expect(widget).toContain(`label: "${day}"`);
    }
  });

  test("offers an accessible ±15-minute toggle and centralized slot controls", () => {
    expect(widget).toContain('role="switch"');
    expect(widget).toContain(
      'aria-label="Vary posting queue times by up to 15 minutes"',
    );
    expect(widget).toContain("timeVariationEnabled");
    expect(widget).toContain("Recurring posting times");
    expect(widget).toContain("Removing an occupied slot keeps");
  });
});
