import { describe, expect, test } from "vitest";
import {
  createAgentInbox,
  type AgentInboxIdea,
  type AgentInboxRepository,
  type AgentInboxSynthesis,
} from "@/lib/agent-inbox";

const NOW = new Date("2026-07-30T08:00:00.000Z");

function idea(
  lane: AgentInboxIdea["lane"],
  overrides: Partial<AgentInboxIdea> = {},
): AgentInboxIdea {
  return {
    id: `${lane}-idea`,
    workspaceId: "workspace-1",
    lane,
    status: "active",
    headline: `${lane} headline`,
    angle: `${lane} angle`,
    why: [`${lane} evidence`],
    evidence: [],
    sourceKind: lane === "now" ? "news" : "workspace_learning",
    sourceRef: null,
    sourceUrl: null,
    sourceTitle: null,
    sourcePublishedAt: null,
    score: 0.8,
    fingerprint: `${lane}-fingerprint`,
    availableOn: "2026-07-30",
    expiresAt: null,
    snoozedUntil: null,
    actedAt: null,
    discardReason: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function repository(initial: AgentInboxIdea[] = []): AgentInboxRepository & {
  ideas: AgentInboxIdea[];
  claims: Set<string>;
} {
  const ideas = [...initial];
  const claims = new Set<string>();
  return {
    ideas,
    claims,
    async readActive() {
      return ideas.filter((entry) => entry.status === "active");
    },
    async readRecentActivity() {
      return ideas.filter((entry) => entry.status !== "active");
    },
    async readRecentFingerprints() {
      return new Set(ideas.map((entry) => entry.fingerprint));
    },
    async releaseDueSnoozed(_workspaceId, now) {
      for (const entry of ideas) {
        if (
          entry.status === "snoozed" &&
          entry.snoozedUntil &&
          entry.snoozedUntil <= now.toISOString()
        ) {
          entry.status = "active";
          entry.snoozedUntil = null;
        }
      }
    },
    async claimDailyRun(_workspaceId, localDate) {
      if (claims.has(localDate)) return false;
      claims.add(localDate);
      return true;
    },
    async completeDailyRun() {},
    async failDailyRun() {},
    async insertIdeas(_workspaceId, generated) {
      const inserted = generated.map((entry, index) =>
        idea(entry.lane, {
          ...entry,
          id: `${entry.lane}-generated-${index}`,
          workspaceId: "workspace-1",
          status: "active",
          availableOn: "2026-07-30",
          snoozedUntil: null,
          actedAt: null,
          discardReason: null,
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
        }),
      );
      ideas.push(...inserted);
      return inserted;
    },
    async transition(_workspaceId, id, action) {
      const entry = ideas.find((candidate) => candidate.id === id);
      if (!entry || entry.status !== "active") return null;
      entry.status =
        action.kind === "act"
          ? "acted"
          : action.kind === "discard"
            ? "discarded"
            : "snoozed";
      entry.actedAt = action.kind === "act" ? NOW.toISOString() : entry.actedAt;
      entry.discardReason =
        action.kind === "discard" ? (action.reason ?? null) : null;
      entry.snoozedUntil =
        action.kind === "snooze" ? action.until.toISOString() : null;
      return entry;
    },
    async readPreferences() {
      return {
        enabled: true,
        timezone: "UTC",
        deliveryLocalTime: "08:00",
        topics: [],
        newsSensitivity: "standard" as const,
      };
    },
  };
}

function synthesis(): AgentInboxSynthesis {
  return {
    async synthesize({ lanes, evidence }) {
      return lanes.map((lane) => ({
        lane,
        headline: `${lane} generated`,
        angle: `A distinct ${lane} angle`,
        why: [`Evidence for ${lane}`],
        evidence: lane === "now" ? evidence.news : [],
        sourceKind: lane === "now" ? "news" : "workspace_learning",
        sourceRef: null,
        sourceUrl: null,
        sourceTitle: null,
        sourcePublishedAt: null,
        score: 0.85,
        fingerprint: `${lane}-new`,
        expiresAt: null,
      }));
    },
  };
}

describe("AgentInbox", () => {
  test("replenishes only empty lanes and preserves ideas the user has not handled", async () => {
    const existing = idea("proven");
    const repo = repository([existing]);
    const inbox = createAgentInbox({
      repository: repo,
      synthesis: synthesis(),
      loadEvidence: async () => ({
        news: [
          {
            kind: "news",
            label: "Fresh announcement",
            detail: "A verified story",
            url: "https://example.com/story",
            publishedAt: "2026-07-30",
          },
        ],
        learning: [],
        knowledge: [],
      }),
    });

    const result = await inbox.replenish({
      workspaceId: "workspace-1",
      now: NOW,
      timezone: "UTC",
    });

    expect(result.created.map((entry) => entry.lane)).toEqual([
      "now",
      "explore",
    ]);
    expect(repo.ideas.find((entry) => entry.id === existing.id)).toBe(existing);
    expect(
      repo.ideas.filter((entry) => entry.status === "active"),
    ).toHaveLength(3);
  });

  test("runs at most once per workspace local day", async () => {
    const repo = repository();
    let syntheses = 0;
    const inbox = createAgentInbox({
      repository: repo,
      synthesis: {
        async synthesize(input) {
          syntheses += 1;
          return synthesis().synthesize(input);
        },
      },
      loadEvidence: async () => ({ news: [], learning: [], knowledge: [] }),
    });

    await inbox.replenish({
      workspaceId: "workspace-1",
      now: NOW,
      timezone: "UTC",
    });
    const duplicate = await inbox.replenish({
      workspaceId: "workspace-1",
      now: NOW,
      timezone: "UTC",
    });

    expect(syntheses).toBe(1);
    expect(duplicate).toMatchObject({ skipped: "already_ran", created: [] });
  });

  test("does not manufacture a Now idea when there is no verified fresh news", async () => {
    const repo = repository();
    const inbox = createAgentInbox({
      repository: repo,
      synthesis: synthesis(),
      loadEvidence: async () => ({ news: [], learning: [], knowledge: [] }),
    });

    const result = await inbox.replenish({
      workspaceId: "workspace-1",
      now: NOW,
      timezone: "UTC",
    });

    expect(result.created.map((entry) => entry.lane)).toEqual([
      "proven",
      "explore",
    ]);
  });

  test("an acted-on idea leaves its lane empty until the next daily run", async () => {
    const active = idea("proven");
    const repo = repository([active]);
    const inbox = createAgentInbox({
      repository: repo,
      synthesis: synthesis(),
      loadEvidence: async () => ({ news: [], learning: [], knowledge: [] }),
    });

    const transitioned = await inbox.transition({
      workspaceId: "workspace-1",
      ideaId: active.id,
      action: { kind: "act" },
    });
    const state = await inbox.read("workspace-1", NOW);

    expect(transitioned?.status).toBe("acted");
    expect(state.active).toEqual([]);
    expect(state.activity[0]?.status).toBe("acted");
  });

  test("a due snoozed idea returns before a replacement is considered", async () => {
    const snoozed = idea("explore", {
      status: "snoozed",
      snoozedUntil: "2026-07-30T07:00:00.000Z",
    });
    const repo = repository([snoozed]);
    const inbox = createAgentInbox({
      repository: repo,
      synthesis: synthesis(),
      loadEvidence: async () => ({ news: [], learning: [], knowledge: [] }),
    });

    const result = await inbox.replenish({
      workspaceId: "workspace-1",
      now: NOW,
      timezone: "UTC",
    });

    expect(result.created.map((entry) => entry.lane)).toEqual(["proven"]);
    expect(snoozed.status).toBe("active");
  });
});
