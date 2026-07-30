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
    async readRecentSources() {
      return new Set(
        ideas
          .map((entry) => entry.sourceUrl ?? entry.sourceRef)
          .filter((value): value is string => Boolean(value)),
      );
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
    // Mirrors the SQL: the claim goes back so a later tick can retry the day.
    async releaseDailyRun(_workspaceId, localDate) {
      claims.delete(localDate);
    },
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
      if (!entry) return null;
      // Restore is the one transition that starts from a non-active idea.
      if (action.kind === "restore") {
        if (entry.status !== "acted") return null;
        entry.status = "active";
        entry.actedAt = null;
        return entry;
      }
      if (entry.status !== "active") return null;
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

function multiSynthesis(ideasPerLane: number): AgentInboxSynthesis {
  return {
    async synthesize({ lanes, evidence }) {
      return lanes.flatMap((lane) =>
        Array.from({ length: ideasPerLane }, (_, index) => ({
          lane,
          headline: `${lane} generated ${index + 1}`,
          angle: `A distinct ${lane} angle ${index + 1}`,
          why: [`Evidence for ${lane}`],
          evidence: lane === "now" ? evidence.news : [],
          sourceKind: lane === "now" ? "news" : "workspace_learning",
          sourceRef: null,
          sourceUrl: null,
          sourceTitle: null,
          sourcePublishedAt: null,
          score: 0.85,
          fingerprint: `${lane}-new-${index + 1}`,
          expiresAt: null,
        })),
      );
    },
  };
}

const NEWS_EVIDENCE = {
  news: [
    {
      kind: "news" as const,
      label: "Fresh announcement",
      detail: "A verified story",
      url: "https://example.com/story",
      publishedAt: "2026-07-30",
    },
  ],
  learning: [],
  knowledge: [],
};

const NO_EVIDENCE = { news: [], learning: [], knowledge: [] };

describe("AgentInbox", () => {
  test("tops up lanes below capacity and preserves ideas the user has not handled", async () => {
    const existing = idea("proven");
    const repo = repository([existing]);
    const inbox = createAgentInbox({
      repository: repo,
      synthesis: synthesis(),
      loadEvidence: async () => NEWS_EVIDENCE,
    });

    const result = await inbox.replenish({
      workspaceId: "workspace-1",
      now: NOW,
      timezone: "UTC",
    });

    expect(result.created.map((entry) => entry.lane)).toEqual([
      "now",
      "proven",
      "explore",
    ]);
    expect(repo.ideas.find((entry) => entry.id === existing.id)).toBe(existing);
    expect(
      repo.ideas.filter((entry) => entry.status === "active"),
    ).toHaveLength(4);
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

  test("a due snoozed idea returns and its lane tops up around it", async () => {
    const snoozed = idea("explore", {
      status: "snoozed",
      snoozedUntil: "2026-07-30T07:00:00.000Z",
    });
    const repo = repository([snoozed]);
    const inbox = createAgentInbox({
      repository: repo,
      synthesis: synthesis(),
      loadEvidence: async () => NO_EVIDENCE,
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
    expect(snoozed.status).toBe("active");
  });

  test("reports full only when every lane holds three active ideas", async () => {
    const repo = repository(
      (["now", "proven", "explore"] as const).flatMap((lane) =>
        [1, 2, 3].map((index) =>
          idea(lane, {
            id: `${lane}-${index}`,
            fingerprint: `${lane}-fingerprint-${index}`,
          }),
        ),
      ),
    );
    let syntheses = 0;
    const inbox = createAgentInbox({
      repository: repo,
      synthesis: {
        async synthesize(input) {
          syntheses += 1;
          return synthesis().synthesize(input);
        },
      },
      loadEvidence: async () => NEWS_EVIDENCE,
    });

    const result = await inbox.replenish({
      workspaceId: "workspace-1",
      now: NOW,
      timezone: "UTC",
    });

    expect(result).toMatchObject({ skipped: "full", created: [] });
    expect(result.retained).toHaveLength(9);
    expect(syntheses).toBe(0);
  });

  test("accepts three ideas for a lane when evidence supports them", async () => {
    const repo = repository();
    const inbox = createAgentInbox({
      repository: repo,
      synthesis: multiSynthesis(3),
      loadEvidence: async () => NEWS_EVIDENCE,
    });

    const result = await inbox.replenish({
      workspaceId: "workspace-1",
      now: NOW,
      timezone: "UTC",
    });

    expect(result.created).toHaveLength(9);
    for (const lane of ["now", "proven", "explore"] as const) {
      expect(
        result.created.filter((entry) => entry.lane === lane),
      ).toHaveLength(3);
    }
  });

  test("caps a lane at three ideas even when synthesis returns more", async () => {
    const repo = repository();
    const inbox = createAgentInbox({
      repository: repo,
      synthesis: multiSynthesis(5),
      loadEvidence: async () => NEWS_EVIDENCE,
    });

    const result = await inbox.replenish({
      workspaceId: "workspace-1",
      now: NOW,
      timezone: "UTC",
    });

    expect(result.created).toHaveLength(9);
    for (const lane of ["now", "proven", "explore"] as const) {
      expect(
        result.created.filter((entry) => entry.lane === lane),
      ).toHaveLength(3);
    }
  });

  test("tops up a lane with two active ideas by exactly one more", async () => {
    const repo = repository([
      idea("proven", { id: "proven-1", fingerprint: "proven-fp-1" }),
      idea("proven", { id: "proven-2", fingerprint: "proven-fp-2" }),
    ]);
    const inbox = createAgentInbox({
      repository: repo,
      synthesis: multiSynthesis(3),
      loadEvidence: async () => NO_EVIDENCE,
    });

    const result = await inbox.replenish({
      workspaceId: "workspace-1",
      now: NOW,
      timezone: "UTC",
    });

    expect(result.created.filter((entry) => entry.lane === "proven"))
      .toHaveLength(1);
    expect(result.created.filter((entry) => entry.lane === "explore"))
      .toHaveLength(3);
    expect(
      repo.ideas.filter(
        (entry) => entry.lane === "proven" && entry.status === "active",
      ),
    ).toHaveLength(3);
  });

  test("accepts a single idea for a lane without padding to the cap", async () => {
    const repo = repository();
    const inbox = createAgentInbox({
      repository: repo,
      synthesis: {
        async synthesize() {
          return [
            {
              lane: "proven" as const,
              headline: "One strong proven idea",
              angle: "The only angle the evidence supports",
              why: ["Grounded in the user's results"],
              evidence: [],
              sourceKind: "workspace_learning" as const,
              sourceRef: null,
              sourceUrl: null,
              sourceTitle: null,
              sourcePublishedAt: null,
              score: 0.9,
              fingerprint: "proven-only",
              expiresAt: null,
            },
          ];
        },
      },
      loadEvidence: async () => NO_EVIDENCE,
    });

    const result = await inbox.replenish({
      workspaceId: "workspace-1",
      now: NOW,
      timezone: "UTC",
    });

    expect(result.created.map((entry) => entry.lane)).toEqual(["proven"]);
  });

  test("never accepts two ideas built on the same source in one run", async () => {
    const repo = repository();
    const inbox = createAgentInbox({
      repository: repo,
      synthesis: {
        async synthesize() {
          return [1, 2].map((index) => ({
            lane: "proven" as const,
            headline: `Same-story idea ${index}`,
            angle: `Angle ${index} on the same story`,
            why: ["Same underlying source"],
            evidence: [],
            sourceKind: "news" as const,
            sourceRef: null,
            sourceUrl: "https://example.com/same-story",
            sourceTitle: "Same story",
            sourcePublishedAt: null,
            score: 0.9,
            fingerprint: `same-story-${index}`,
            expiresAt: null,
          }));
        },
      },
      loadEvidence: async () => NO_EVIDENCE,
    });

    const result = await inbox.replenish({
      workspaceId: "workspace-1",
      now: NOW,
      timezone: "UTC",
    });

    expect(result.created).toHaveLength(1);
  });

  test("a top-up run never re-pitches a source already on the board", async () => {
    const repo = repository([
      idea("proven", {
        id: "proven-1",
        fingerprint: "proven-fp-1",
        sourceUrl: "https://example.com/already-live",
      }),
    ]);
    const inbox = createAgentInbox({
      repository: repo,
      synthesis: {
        async synthesize() {
          return [
            {
              lane: "proven" as const,
              headline: "New angle on the live story",
              angle: "Different angle, same source",
              why: ["Same underlying source"],
              evidence: [],
              sourceKind: "news" as const,
              sourceRef: null,
              sourceUrl: "https://example.com/already-live",
              sourceTitle: "Already live",
              sourcePublishedAt: null,
              score: 0.9,
              fingerprint: "already-live-new-angle",
              expiresAt: null,
            },
          ];
        },
      },
      loadEvidence: async () => NO_EVIDENCE,
    });

    const result = await inbox.replenish({
      workspaceId: "workspace-1",
      now: NOW,
      timezone: "UTC",
    });

    expect(result.created).toHaveLength(0);
  });

  test("a Now-only run with no news gives its claim back so news can land later", async () => {
    // The other two lanes are already full, so `now` is the only outstanding
    // work. Without releasing the claim the run marked the day done, and news
    // breaking at midday could not reach the board until local midnight.
    const full = [
      ...Array.from({ length: 3 }, (_, i) =>
        idea("proven", { id: `proven-${i}`, fingerprint: `proven-${i}` }),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        idea("explore", { id: `explore-${i}`, fingerprint: `explore-${i}` }),
      ),
    ];
    const repo = repository(full);
    let newsAvailable = false;
    const inbox = createAgentInbox({
      repository: repo,
      synthesis: synthesis(),
      loadEvidence: async () =>
        newsAvailable ? NEWS_EVIDENCE : { news: [], learning: [], knowledge: [] },
    });

    const morning = await inbox.replenish({
      workspaceId: "workspace-1",
      now: NOW,
      timezone: "UTC",
    });
    expect(morning).toMatchObject({ skipped: "no_evidence", created: [] });

    // Same local date: the retry must not be refused as already_ran.
    newsAvailable = true;
    const afternoon = await inbox.replenish({
      workspaceId: "workspace-1",
      now: NOW,
      timezone: "UTC",
    });
    expect(afternoon.created.map((entry) => entry.lane)).toEqual(["now"]);
  });

  test("a source pitched on an earlier day is not pitched again", async () => {
    // Fingerprints only block an identical idea. The same story re-angled
    // under a new headline hashes differently, so without a source-level
    // window it returned the next day as though it were new.
    const yesterday = idea("proven", {
      id: "yesterday",
      status: "acted",
      fingerprint: "yesterday-fingerprint",
      sourceUrl: "https://example.com/same-story",
    });
    const repo = repository([yesterday]);
    const inbox = createAgentInbox({
      repository: repo,
      synthesis: {
        async synthesize({ lanes }) {
          return lanes.map((lane) => ({
            lane,
            headline: `${lane} fresh angle`,
            angle: `A different framing of the same story for ${lane}`,
            why: ["Re-angled"],
            evidence: [],
            sourceKind: "workspace_learning" as const,
            sourceRef: null,
            sourceUrl: "https://example.com/same-story",
            sourceTitle: "Same story",
            sourcePublishedAt: null,
            score: 0.9,
            fingerprint: `${lane}-different-hash`,
            expiresAt: null,
          }));
        },
      },
      loadEvidence: async () => NO_EVIDENCE,
    });

    const result = await inbox.replenish({
      workspaceId: "workspace-1",
      now: NOW,
      timezone: "UTC",
    });

    expect(result.created).toHaveLength(0);
  });

  test("restore returns a just-acted idea to the board", async () => {
    // The Cowork handoff can fail after the transition commits; without this
    // the card is gone and no draft exists.
    const active = idea("proven");
    const repo = repository([active]);
    const inbox = createAgentInbox({
      repository: repo,
      synthesis: synthesis(),
      loadEvidence: async () => NO_EVIDENCE,
    });

    await inbox.transition({
      workspaceId: "workspace-1",
      ideaId: active.id,
      action: { kind: "act" },
    });
    const restored = await inbox.transition({
      workspaceId: "workspace-1",
      ideaId: active.id,
      action: { kind: "restore" },
    });

    expect(restored?.status).toBe("active");
    expect(restored?.actedAt).toBeNull();
    const state = await inbox.read("workspace-1", NOW);
    expect(state.active.map((entry) => entry.id)).toContain(active.id);
  });

  test("restore does not resurrect a discarded idea", async () => {
    const active = idea("proven");
    const repo = repository([active]);
    const inbox = createAgentInbox({
      repository: repo,
      synthesis: synthesis(),
      loadEvidence: async () => NO_EVIDENCE,
    });

    await inbox.transition({
      workspaceId: "workspace-1",
      ideaId: active.id,
      action: { kind: "discard", reason: "Not relevant" },
    });
    const restored = await inbox.transition({
      workspaceId: "workspace-1",
      ideaId: active.id,
      action: { kind: "restore" },
    });

    expect(restored).toBeNull();
  });
});
