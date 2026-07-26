import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const component = readFileSync(
  "app/(app)/dashboard/post-outcomes.tsx",
  "utf8",
);
const editor = readFileSync(
  "app/(app)/dashboard/draft-editor-modal.tsx",
  "utf8",
);

describe("manual business outcome UI", () => {
  test("appears for published Posts and labels manual attribution honestly", () => {
    expect(editor).toContain('draft.status === "posted"');
    expect(editor).toContain('draft.scheduleStatus === "published"');
    expect(component).toContain("Business outcomes");
    expect(component).toContain("this post influenced");
    expect(component).toContain("Reported by you");
  });

  test("supports money, corrections, accessible actions, and stable retries", () => {
    expect(component).toContain("amountMinor");
    expect(component).toContain("requestId.current ??= crypto.randomUUID()");
    expect(component).toContain("Why are you correcting it?");
    expect(component).toContain("Save correction");
    expect(component).toContain("Couldn&apos;t load outcomes.");
    expect(component).toContain(
      'aria-label={`Correct ${outcomeLabel(outcome.kind)}`}',
    );
  });
});
