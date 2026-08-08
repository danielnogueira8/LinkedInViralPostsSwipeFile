import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PREDRAFT_SETTLE_MS,
  summarizeAgentDraftOutcomes,
  type AgentDraftOutcomeRow,
} from "@/lib/agent-loop/predraft-metrics";

// ---------------------------------------------------------------------------
// These two rates decide whether the pre-draft cap rises. A wrong denominator
// does not throw — it produces a confident wrong number that gets acted on —
// so the definitions are pinned here rather than left to the reader.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-08T12:00:00.000Z");
const OLD = new Date(NOW.getTime() - PREDRAFT_SETTLE_MS - 60_000).toISOString();
const FRESH = new Date(NOW.getTime() - 60_000).toISOString();

function row(over: Partial<AgentDraftOutcomeRow>): AgentDraftOutcomeRow {
  return {
    id: over.id ?? "d1",
    createdAt: over.createdAt ?? OLD,
    scheduleStatus: over.scheduleStatus ?? null,
    editCount: over.editCount ?? 0,
  };
}

describe("scheduled-without-edit rate", () => {
  it("is measured against scheduled drafts, not all drafts", () => {
    // The question is "when they ship it, do they ship it as written" — so
    // drafts nobody scheduled must not dilute it.
    const summary = summarizeAgentDraftOutcomes(
      [
        row({ id: "a", scheduleStatus: "scheduled", editCount: 0 }),
        row({ id: "b", scheduleStatus: "scheduled", editCount: 3 }),
        row({ id: "c", scheduleStatus: null, editCount: 0 }),
        row({ id: "d", scheduleStatus: null, editCount: 0 }),
      ],
      NOW,
    );
    expect(summary.scheduled).toBe(2);
    expect(summary.scheduledWithoutEdit).toBe(1);
    expect(summary.scheduledAfterEdit).toBe(1);
    expect(summary.rates.scheduledWithoutEdit).toBe(0.5);
  });

  it("counts a scheduling decision immediately, with no settle window", () => {
    // Scheduling IS the decision. Waiting would undercount the numerator
    // against a denominator that already contains the draft.
    const summary = summarizeAgentDraftOutcomes(
      [row({ createdAt: FRESH, scheduleStatus: "scheduled" })],
      NOW,
    );
    expect(summary.scheduled).toBe(1);
    expect(summary.rates.scheduledWithoutEdit).toBe(1);
  });

  it("treats a failed publish as scheduled, because the human said yes", () => {
    // Publishing broke afterwards; that is a delivery problem, not a
    // rejection. Excluding it would understate demand for these drafts.
    const summary = summarizeAgentDraftOutcomes(
      [row({ scheduleStatus: "failed" })],
      NOW,
    );
    expect(summary.scheduled).toBe(1);
    expect(summary.ignored).toBe(0);
  });

  it("counts every post-decision state as scheduled", () => {
    const statuses = ["scheduled", "publishing", "published", "failed"] as const;
    for (const status of statuses) {
      expect(
        summarizeAgentDraftOutcomes([row({ scheduleStatus: status })], NOW)
          .scheduled,
      ).toBe(1);
    }
  });
});

describe("ignored rate", () => {
  it("only judges drafts old enough to have been seen", () => {
    // Counting a draft written a minute ago would make the rate a function of
    // when the report ran rather than of user behavior.
    const summary = summarizeAgentDraftOutcomes(
      [
        row({ id: "old", createdAt: OLD }),
        row({ id: "fresh", createdAt: FRESH }),
      ],
      NOW,
    );
    expect(summary.total).toBe(2);
    expect(summary.settled).toBe(1);
    expect(summary.ignored).toBe(1);
    expect(summary.rates.ignored).toBe(1);
  });

  it("separates ignored from engaged-then-rejected", () => {
    // Edited but never scheduled is a DIFFERENT signal from never touched:
    // the first says the idea was worth work, the second says it was spam.
    const summary = summarizeAgentDraftOutcomes(
      [
        row({ id: "untouched", editCount: 0 }),
        row({ id: "worked-on", editCount: 4 }),
      ],
      NOW,
    );
    expect(summary.ignored).toBe(1);
    expect(summary.editedNotScheduled).toBe(1);
    expect(summary.rates.ignored).toBe(0.5);
  });

  it("does not count a scheduled draft as ignored", () => {
    const summary = summarizeAgentDraftOutcomes(
      [row({ scheduleStatus: "published" })],
      NOW,
    );
    expect(summary.ignored).toBe(0);
    expect(summary.settled).toBe(1);
  });
});

describe("degenerate inputs", () => {
  it("returns null rather than NaN when a denominator is zero", () => {
    // 0/0 rendered as a number is worse than an absent number: it reads as a
    // real measurement and gets acted on.
    const empty = summarizeAgentDraftOutcomes([], NOW);
    expect(empty.rates.scheduledWithoutEdit).toBeNull();
    expect(empty.rates.ignored).toBeNull();
    expect(empty.total).toBe(0);

    const freshOnly = summarizeAgentDraftOutcomes(
      [row({ createdAt: FRESH })],
      NOW,
    );
    expect(freshOnly.rates.ignored).toBeNull();
    expect(freshOnly.rates.scheduledWithoutEdit).toBeNull();
  });

  it("ignores a row with an unparseable timestamp instead of settling it", () => {
    const summary = summarizeAgentDraftOutcomes(
      [row({ createdAt: "not-a-date" })],
      NOW,
    );
    expect(summary.settled).toBe(0);
    expect(summary.ignored).toBe(0);
  });

  it("settles exactly at the boundary", () => {
    const exact = new Date(NOW.getTime() - PREDRAFT_SETTLE_MS).toISOString();
    expect(
      summarizeAgentDraftOutcomes([row({ createdAt: exact })], NOW).settled,
    ).toBe(1);
  });
});

describe("stats route", () => {
  const ROUTE = readFileSync(
    path.join(process.cwd(), "app/api/internal/agent-predraft-stats/route.ts"),
    "utf8",
  );

  it("is admin-or-secret, never user-facing", () => {
    expect(ROUTE).toContain("requireAdmin");
    expect(ROUTE).toContain("CRON_SECRET");
  });

  it("is read only", () => {
    const code = ROUTE
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
  });

  it("measures only agent-written drafts", () => {
    expect(ROUTE).toContain("AGENT_SUGGESTED_BY");
    expect(ROUTE).toContain('"meta->>suggested_by"');
  });

  it("reports when the row cap truncated the window", () => {
    // A silently truncated sample would look like a complete measurement.
    expect(ROUTE).toContain("truncated");
  });
});
