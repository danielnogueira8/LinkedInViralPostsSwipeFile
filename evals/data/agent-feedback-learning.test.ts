import { describe, expect, it } from "vitest";
import { loadAgentDismissalFeedback } from "@/lib/agent-inbox/feedback";

function fakeDb(overrides?: Record<string, unknown[]>) {
  const tables: Record<string, unknown[]> = overrides ?? {
    agent_inbox_ideas: [
      {
        lane: "educational",
        headline: "Five generic writing tips",
        discard_reason: "Too generic",
      },
      {
        lane: "retired_lane",
        headline: "Legacy feedback",
        discard_reason: "Too generic",
      },
    ],
    agent_opportunities: [
      {
        kind: "trend",
        payload: {
          headline: "A repeated trend take",
          dismiss_reason: "I've already said this",
        },
      },
      {
        kind: "news",
        payload: {
          headline: "A verified platform announcement",
          dismiss_reason: "Not timely",
        },
      },
      {
        kind: "trend",
        payload: {
          signal_type: "newsjacking",
          headline: "A legacy verified announcement",
          dismiss_reason: "Forced connection",
        },
      },
      {
        kind: "outlier",
        payload: {
          headline: "An unrelated opportunity",
          dismiss_reason: "Not relevant to me",
        },
      },
    ],
  };
  const orderCalls: Array<{
    column: string;
    options: Record<string, unknown>;
  }> = [];
  return {
    orderCalls,
    from(table: string) {
      let rowLimit = Number.POSITIVE_INFINITY;
      const chain: Record<string, unknown> = {};
      const pass = () => chain;
      Object.assign(chain, {
        select: pass,
        eq: pass,
        in: pass,
        not: pass,
        order: (column: string, options: Record<string, unknown>) => {
          orderCalls.push({ column, options });
          return chain;
        },
        limit: (value: number) => {
          rowLimit = value;
          return chain;
        },
        then: (
          resolve: (value: { data: unknown[]; error: null }) => unknown,
          reject: (reason: unknown) => unknown,
        ) =>
          Promise.resolve({
            data: (tables[table] ?? []).slice(0, rowLimit),
            error: null,
          }).then(
            resolve,
            reject,
          ),
      });
      return chain;
    },
  };
}

describe("shared agent feedback learning", () => {
  it("combines generated and external-agent dismissals", async () => {
    const feedback = await loadAgentDismissalFeedback(
      fakeDb() as never,
      "workspace-1",
    );
    expect(feedback).toEqual([
      {
        lane: "educational",
        headline: "Five generic writing tips",
        reason: "Too generic",
      },
      {
        lane: "trend_radar",
        headline: "A repeated trend take",
        reason: "I've already said this",
      },
      {
        lane: "newsjacking",
        headline: "A verified platform announcement",
        reason: "Not timely",
      },
      {
        lane: "newsjacking",
        headline: "A legacy verified announcement",
        reason: "Forced connection",
      },
    ]);
  });

  it("orders all lanes by recency before applying the shared limit", async () => {
    const inbox = Array.from({ length: 30 }, (_, index) => ({
      lane: "educational",
      headline: `Older inbox feedback ${index}`,
      discard_reason: "Too generic",
      updated_at: new Date(Date.UTC(2026, 6, 30, 0, 0, index)).toISOString(),
    }));
    const external = Array.from({ length: 30 }, (_, index) => ({
      kind: "news",
      payload: {
        headline: `Newer external feedback ${index}`,
        dismiss_reason: "Not timely",
      },
      acted_at: new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString(),
    }));

    const feedback = await loadAgentDismissalFeedback(
      fakeDb({
        agent_inbox_ideas: inbox,
        agent_opportunities: external,
      }) as never,
      "workspace-1",
    );

    expect(feedback).toHaveLength(40);
    expect(feedback.slice(0, 30).every((entry) => entry.lane === "newsjacking"))
      .toBe(true);
    expect(feedback.slice(30).every((entry) => entry.lane === "educational"))
      .toBe(true);
  });

  it("keeps missing timestamps behind dated feedback before and after loading", async () => {
    const db = fakeDb({
      agent_inbox_ideas: [
        {
          lane: "educational",
          headline: "Dated historical feedback",
          discard_reason: "Too generic",
          updated_at: "1960-01-01T00:00:00.000Z",
        },
      ],
      agent_opportunities: [
        {
          kind: "news",
          payload: {
            headline: "Undated feedback",
            dismiss_reason: "Not timely",
          },
          acted_at: null,
        },
        {
          kind: "news",
          payload: {
            headline: "Malformed timestamp feedback",
            dismiss_reason: "Not timely",
          },
          acted_at: "2026-02-30T00:00:00Z",
        },
      ],
    });

    const feedback = await loadAgentDismissalFeedback(
      db as never,
      "workspace-1",
    );

    expect(feedback.map((entry) => entry.headline)).toEqual([
      "Dated historical feedback",
      "Undated feedback",
      "Malformed timestamp feedback",
    ]);
    expect(db.orderCalls).toEqual([
      {
        column: "updated_at",
        options: { ascending: false, nullsFirst: false },
      },
      {
        column: "acted_at",
        options: { ascending: false, nullsFirst: false },
      },
    ]);
  });

  it("can select the newest forty from one source and preserves microsecond order", async () => {
    const inbox = Array.from({ length: 40 }, (_, index) => ({
      lane: "educational",
      headline: `Newest inbox feedback ${index}`,
      discard_reason: "Too generic",
      updated_at:
        index === 0
          ? "2026-08-02T10:00:00.000001Z"
          : new Date(Date.UTC(2026, 7, 2, 9, 59, 59 - index)).toISOString(),
    }));
    const external = [
      {
        kind: "news",
        payload: {
          headline: "Newer within the same millisecond",
          dismiss_reason: "Not timely",
        },
        acted_at: "2026-08-02T10:00:00.000999Z",
      },
      ...Array.from({ length: 19 }, (_, index) => ({
        kind: "news",
        payload: {
          headline: `Older external feedback ${index}`,
          dismiss_reason: "Not timely",
        },
        acted_at: "1960-01-01T00:00:00.000000Z",
      })),
    ];

    const feedback = await loadAgentDismissalFeedback(
      fakeDb({
        agent_inbox_ideas: inbox,
        agent_opportunities: external,
      }) as never,
      "workspace-1",
    );

    expect(feedback).toHaveLength(40);
    expect(feedback[0]?.headline).toBe("Newer within the same millisecond");
    expect(feedback.filter((entry) => entry.lane === "educational")).toHaveLength(
      39,
    );
  });
});
