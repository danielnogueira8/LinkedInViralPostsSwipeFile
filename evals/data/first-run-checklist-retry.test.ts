import { describe, expect, test } from "vitest";
import { shouldHaltChecklist } from "@/app/(app)/dashboard/first-run-checklist";

describe("first-run checklist retry policy", () => {
  test("a failed response remains retryable on the next dashboard navigation", () => {
    expect(shouldHaltChecklist({ ok: false })).toBe(false);
    expect(shouldHaltChecklist(null)).toBe(false);
  });

  test("a dismissed or completed checklist can stop future reads", () => {
    expect(
      shouldHaltChecklist({
        ok: true,
        items: { creators: false },
        dismissed: true,
      }),
    ).toBe(true);
    expect(
      shouldHaltChecklist({
        ok: true,
        items: {
          voice: true,
          linkedin: true,
          creators: true,
          inspiration: true,
          batch: true,
          scheduled: true,
        },
      }),
    ).toBe(true);
  });
});
