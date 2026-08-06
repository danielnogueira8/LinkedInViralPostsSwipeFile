import { describe, expect, it } from "vitest";
import { resolveRelativeCutoff } from "@/app/(app)/dashboard/settings/form";
import { RELATIVE_CUTOFF_DISABLED } from "@/lib/viral";

// A toggle and a number field both express "is the top-performer filter on",
// so they have to agree. These pin the rule that reconciles them — the failure
// mode being a switch that reads "on" over a filter doing nothing.

describe("typing 100 turns the filter off instead of erroring", () => {
  it("resolves to the disabled value", () => {
    const choice = resolveRelativeCutoff(true, "100");
    expect(choice.cutoffPct).toBe(RELATIVE_CUTOFF_DISABLED);
    expect(choice.error).toBeUndefined();
  });

  it("reports disabled so the toggle can follow", () => {
    // Without this the switch stays on while the gate is off.
    expect(resolveRelativeCutoff(true, "100").disabled).toBe(true);
  });

  it("treats anything above 100 the same way", () => {
    // The input caps at 100, but a pasted value should not error either.
    expect(resolveRelativeCutoff(true, "250").cutoffPct).toBe(
      RELATIVE_CUTOFF_DISABLED,
    );
    expect(resolveRelativeCutoff(true, "250").error).toBeUndefined();
  });
});

describe("0 is still refused", () => {
  it("errors rather than guessing", () => {
    // "Top 0%" is not a way to say off — it asks for a filter nothing passes.
    // Coercing it to 1 or to 100 would guess wrong half the time.
    const choice = resolveRelativeCutoff(true, "0");
    expect(choice.error).toBeTruthy();
  });

  it("tells the user how to turn the filter off", () => {
    // The old message said what was NOT allowed and left the user stuck.
    expect(resolveRelativeCutoff(true, "0").error).toMatch(/100|toggle/i);
  });

  it("refuses an empty or junk field", () => {
    expect(resolveRelativeCutoff(true, "").error).toBeTruthy();
    expect(resolveRelativeCutoff(true, "abc").error).toBeTruthy();
    expect(resolveRelativeCutoff(true, "-5").error).toBeTruthy();
  });
});

describe("ordinary values pass through", () => {
  it("keeps a normal cutoff and stays enabled", () => {
    const choice = resolveRelativeCutoff(true, "20");
    expect(choice).toEqual({ cutoffPct: 20, disabled: false });
  });

  it("accepts both ends of the usable range", () => {
    expect(resolveRelativeCutoff(true, "1").cutoffPct).toBe(1);
    expect(resolveRelativeCutoff(true, "99").cutoffPct).toBe(99);
    expect(resolveRelativeCutoff(true, "99").disabled).toBe(false);
  });

  it("rounds a fractional entry", () => {
    expect(resolveRelativeCutoff(true, "19.6").cutoffPct).toBe(19);
  });
});

describe("the toggle still wins when it is off", () => {
  it("sends the disabled value whatever the field says", () => {
    const choice = resolveRelativeCutoff(false, "20");
    expect(choice.cutoffPct).toBe(RELATIVE_CUTOFF_DISABLED);
    expect(choice.disabled).toBe(true);
  });

  it("does not error on a junk field the user cannot see", () => {
    // The input is disabled in this state, so an error about its contents
    // would be unactionable.
    expect(resolveRelativeCutoff(false, "").error).toBeUndefined();
    expect(resolveRelativeCutoff(false, "0").error).toBeUndefined();
  });
});
