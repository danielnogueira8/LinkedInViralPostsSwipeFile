import { describe, test, expect } from "vitest";
import {
  summarizeUsage,
  digestIsAlert,
  formatDigest,
  type UsageRow,
} from "@/lib/health-digest";

// ---------------------------------------------------------------------------
// The daily health digest aggregator. Turns a month of usage_events rows into a
// spend summary + a cost-pressure list (workspaces near/over their cap), so the
// daily cron can post an actionable Slack/Discord ping. Pure + fully tested.
// ---------------------------------------------------------------------------

const row = (over: Partial<UsageRow>): UsageRow => ({
  workspace_id: "ws_1",
  cost_usd: 0,
  kind: "chat",
  input_tokens: 0,
  output_tokens: 0,
  ...over,
});

describe("summarizeUsage", () => {
  test("totals spend across all rows and counts distinct workspaces", () => {
    const s = summarizeUsage(
      [
        row({ workspace_id: "a", cost_usd: 1.5 }),
        row({ workspace_id: "a", cost_usd: 0.5 }),
        row({ workspace_id: "b", cost_usd: 3 }),
      ],
      15,
    );
    expect(s.totalSpend).toBe(5);
    expect(s.workspaceCount).toBe(2);
  });

  test("flags a workspace OVER the cap and one in the WARN band (>=80%)", () => {
    const s = summarizeUsage(
      [
        row({ workspace_id: "over", cost_usd: 16 }), // 107% → over
        row({ workspace_id: "warn", cost_usd: 12.5 }), // 83% → warn
        row({ workspace_id: "fine", cost_usd: 3 }), // 20% → ok (not listed)
      ],
      15,
    );
    expect(s.pressured.map((w) => w.workspaceId)).toEqual(["over", "warn"]); // worst first
    expect(s.pressured[0].status).toBe("over");
    expect(s.pressured[1].status).toBe("warn");
    // 'fine' is not in the pressured list.
    expect(s.pressured.some((w) => w.workspaceId === "fine")).toBe(false);
  });

  test("pressure list is sorted worst-first by % of cap", () => {
    const s = summarizeUsage(
      [
        row({ workspace_id: "a", cost_usd: 13 }), // 87%
        row({ workspace_id: "b", cost_usd: 30 }), // 200%
        row({ workspace_id: "c", cost_usd: 12 }), // 80%
      ],
      15,
    );
    expect(s.pressured.map((w) => w.workspaceId)).toEqual(["b", "a", "c"]);
  });

  test("breaks spend down by call-kind, biggest first", () => {
    const s = summarizeUsage(
      [
        row({ kind: "chat", cost_usd: 4 }),
        row({ kind: "decide", cost_usd: 0.01 }),
        row({ kind: "chat", cost_usd: 2 }),
        row({ kind: "chat-title", cost_usd: 0.005 }),
      ],
      15,
    );
    expect(s.byKind[0]).toEqual({ kind: "chat", spend: 6, calls: 2 });
    expect(s.byKind.map((k) => k.kind)).toEqual(["chat", "decide", "chat-title"]);
  });

  test("handles null/zero cost and missing workspace gracefully", () => {
    const s = summarizeUsage(
      [
        row({ workspace_id: null, cost_usd: null }),
        row({ workspace_id: "a", cost_usd: 0 }),
      ],
      15,
    );
    expect(s.totalSpend).toBe(0);
    expect(s.workspaceCount).toBe(1); // only the non-null workspace
    expect(s.pressured).toEqual([]);
  });

  test("empty input → an empty (non-alert) summary", () => {
    const s = summarizeUsage([], 15);
    expect(s.totalSpend).toBe(0);
    expect(s.workspaceCount).toBe(0);
    expect(s.pressured).toEqual([]);
    expect(digestIsAlert(s)).toBe(false);
  });
});

describe("digestIsAlert", () => {
  test("alert when any workspace is warn or over", () => {
    expect(digestIsAlert(summarizeUsage([row({ cost_usd: 16 })], 15))).toBe(true);
    expect(digestIsAlert(summarizeUsage([row({ cost_usd: 12.5 })], 15))).toBe(true);
  });
  test("no alert when everyone is comfortably under", () => {
    expect(digestIsAlert(summarizeUsage([row({ cost_usd: 5 })], 15))).toBe(false);
  });
});

describe("formatDigest", () => {
  test("a healthy month renders a clean, no-alert message", () => {
    const s = summarizeUsage([row({ workspace_id: "a", cost_usd: 5 })], 15);
    const msg = formatDigest(s, "July");
    expect(msg).not.toContain("⚠️");
    expect(msg).toContain("$5.00");
    expect(msg).toContain("No workspace near its cap");
  });

  test("a pressured month renders the alert prefix + the offenders", () => {
    const s = summarizeUsage(
      [
        row({ workspace_id: "heavy", cost_usd: 16 }),
        row({ workspace_id: "ok", cost_usd: 2 }),
      ],
      15,
    );
    const msg = formatDigest(s, "July");
    expect(msg).toContain("⚠️");
    expect(msg).toContain("heavy");
    expect(msg).toContain("OVER");
    expect(msg).toContain("107%");
  });

  test("includes the by-kind breakdown", () => {
    const s = summarizeUsage(
      [row({ kind: "chat", cost_usd: 4 }), row({ kind: "decide", cost_usd: 1 })],
      15,
    );
    expect(formatDigest(s, "July")).toContain("chat $4.00");
  });
});
