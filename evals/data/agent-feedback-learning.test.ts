import { describe, expect, it } from "vitest";
import { loadAgentDismissalFeedback } from "@/lib/agent-inbox/feedback";

function fakeDb() {
  const tables: Record<string, unknown[]> = {
    agent_inbox_ideas: [
      {
        lane: "educational",
        headline: "Five generic writing tips",
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
    ],
  };
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      const pass = () => chain;
      Object.assign(chain, {
        select: pass,
        eq: pass,
        not: pass,
        order: pass,
        limit: pass,
        then: (
          resolve: (value: { data: unknown[]; error: null }) => unknown,
          reject: (reason: unknown) => unknown,
        ) =>
          Promise.resolve({ data: tables[table] ?? [], error: null }).then(
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
    ]);
  });
});
