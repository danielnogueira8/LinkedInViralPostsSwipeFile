import { describe, expect, test } from "vitest";
import {
  createAgentInbox,
  type AgentInboxEvidence,
  type AgentInboxEvidenceBundle,
  type AgentInboxIdea,
  type AgentInboxLane,
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
    sourceKind: lane === "newsjacking" ? "news" : "workspace_learning",
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
    readAt: null,
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

// Mirrors laneEvidenceSatisfied: each lane needs its own kind of raw material,
// so the fake attaches what that lane actually requires instead of news-or-
// nothing. A fake that ignores the gate would pass tests the product fails.
function laneEvidence(
  lane: AgentInboxLane,
  bundle: AgentInboxEvidenceBundle,
): AgentInboxEvidence[] {
  if (lane === "newsjacking") return bundle.news;
  if (lane === "personal_story") {
    return [...bundle.sourcePosts, ...bundle.knowledge];
  }
  return [
    ...bundle.sourcePosts,
    ...(bundle.learning.length ? bundle.learning : bundle.knowledge),
  ];
}

function synthesis(): AgentInboxSynthesis {
  return {
    async synthesize({ lanes, evidence }) {
      return lanes.map((lane) => ({
        lane,
        headline: `${lane} generated`,
        angle: `A distinct ${lane} angle`,
        why: [`Evidence for ${lane}`],
        evidence: laneEvidence(lane, evidence),
        sourceKind: lane === "newsjacking" ? "news" : "workspace_learning",
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
          evidence: laneEvidence(lane, evidence),
          sourceKind: lane === "newsjacking" ? "news" : "workspace_learning",
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

// A full bundle: every lane needs its own kind of raw material now, so a
// fixture carrying only news can only ever fill the news-backed lanes.
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
  learning: [
    {
      kind: "performance" as const,
      role: "anchor" as const,
      label: "Teardown posts outperform",
      detail: "A measured result",
      ref: "signal-1",
      confidence: 0.8,
      sampleSize: 12,
    },
  ],
  knowledge: [
    {
      kind: "knowledge" as const,
      role: "anchor" as const,
      label: "The client who fired us",
      detail: "An approved story",
      ref: "knowledge-1",
      subtype: "story",
    },
  ],
  sourcePosts: [
    {
      kind: "source_post" as const,
      role: "inspiration" as const,
      label: "A source post worth modeling",
      detail: "A reusable source structure.",
      ref: "source-post-1",
      url: "https://example.com/source-post-1",
    },
  ],
};

const NO_EVIDENCE = { news: [], learning: [], knowledge: [], sourcePosts: [] };

describe("AgentInbox", () => {
  test("tops up lanes below capacity and preserves ideas the user has not handled", async () => {
    const existing = idea("educational");
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
      "personal_story",
      "educational",
    ]);
    expect(repo.ideas.find((entry) => entry.id === existing.id)).toBe(existing);
    // One pre-existing educational idea, plus one new idea in each of the two
    // lanes (educational tops up from 1 toward the cap rather than resetting).
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
      loadEvidence: async () => ({
        news: [],
        learning: [],
        knowledge: [],
        sourcePosts: [],
      }),
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

    // A run that produces no surviving idea gives its claim back so a later
    // cron tick can retry after evidence changes.
    expect(syntheses).toBe(2);
    expect(duplicate).toMatchObject({ skipped: "no_evidence", created: [] });
  });

  test("does not manufacture an idea when there is no supporting evidence", async () => {
    const repo = repository();
    const inbox = createAgentInbox({
      repository: repo,
      synthesis: synthesis(),
      loadEvidence: async () => ({
        news: [],
        learning: [],
        knowledge: [],
        sourcePosts: [],
      }),
    });

    const result = await inbox.replenish({
      workspaceId: "workspace-1",
      now: NOW,
      timezone: "UTC",
    });

    // No evidence of any kind: every lane's requirement is unmet, so the
    // board stays empty instead of filling with unfounded ideas.
    expect(result.created).toEqual([]);
  });

  test("does not surface legacy newsjacking rows in the current feed", async () => {
    const repo = repository([
      idea("newsjacking"),
      idea("newsjacking", { id: "old-acted", status: "acted" }),
    ]);
    const inbox = createAgentInbox({
      repository: repo,
      synthesis: synthesis(),
      loadEvidence: async () => NO_EVIDENCE,
    });

    const state = await inbox.read("workspace-1", NOW);

    expect(state.active).toEqual([]);
    expect(state.activity).toEqual([]);
  });

  test("an acted-on idea leaves its lane empty until the next daily run", async () => {
    const active = idea("educational");
    const repo = repository([active]);
    const inbox = createAgentInbox({
      repository: repo,
      synthesis: synthesis(),
      loadEvidence: async () => ({
        news: [],
        learning: [],
        knowledge: [],
        sourcePosts: [],
      }),
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
    const snoozed = idea("educational", {
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

    // No evidence of any kind: every lane's requirement is unmet, so the
    // board stays empty instead of filling with unfounded ideas.
    expect(result.created).toEqual([]);
    expect(snoozed.status).toBe("active");
  });

  test("reports full only when every lane holds three active ideas", async () => {
    const repo = repository(
      (["personal_story", "educational"] as const).flatMap((lane) =>
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
    expect(result.retained).toHaveLength(6);
    expect(syntheses).toBe(0);
  });

  test("starts a fresh daily batch even when yesterday's ideas were untouched", async () => {
    const yesterday = (["personal_story", "educational"] as const).flatMap(
      (lane) =>
        Array.from({ length: 3 }, (_, index) =>
          idea(lane, {
            id: `${lane}-yesterday-${index}`,
            availableOn: "2026-07-29",
            createdAt: "2026-07-29T08:00:00.000Z",
            updatedAt: "2026-07-29T08:00:00.000Z",
          }),
        ),
    );
    const repo = repository(yesterday);
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
      "personal_story",
      "educational",
    ]);
    expect(result.created.every((entry) => entry.availableOn === "2026-07-30")).toBe(
      true,
    );
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

    expect(result.created).toHaveLength(6);
    for (const lane of ["personal_story", "educational"] as const) {
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

    expect(result.created).toHaveLength(6);
    for (const lane of ["personal_story", "educational"] as const) {
      expect(
        result.created.filter((entry) => entry.lane === lane),
      ).toHaveLength(3);
    }
  });

  test("tops up a lane with two active ideas by exactly one more", async () => {
    const repo = repository([
      idea("educational", { id: "proven-1", fingerprint: "proven-fp-1" }),
      idea("educational", { id: "proven-2", fingerprint: "proven-fp-2" }),
    ]);
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

    expect(result.created.filter((entry) => entry.lane === "educational"))
      .toHaveLength(1);
    expect(
      repo.ideas.filter(
        (entry) => entry.lane === "educational" && entry.status === "active",
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
              lane: "educational" as const,
              headline: "One strong proven idea",
              angle: "The only angle the evidence supports",
              why: ["Grounded in the user's results"],
              evidence: [
                {
                  kind: "source_post" as const,
                  role: "inspiration" as const,
                  label: "A source structure",
                  detail: "A reusable source structure",
                  ref: "source-1",
                  url: "https://example.com/source-1",
                },
                {
                  kind: "performance" as const,
                  role: "anchor" as const,
                  label: "Teardown posts outperform",
                  detail: "A measured result",
                  ref: "signal-1",
                },
              ],
              sourceKind: "source_post" as const,
              sourceRef: "source-1",
              sourceUrl: "https://example.com/source-1",
              sourceTitle: "A source structure",
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

    expect(result.created.map((entry) => entry.lane)).toEqual(["educational"]);
  });

  test("never accepts two ideas built on the same source in one run", async () => {
    const repo = repository();
    const inbox = createAgentInbox({
      repository: repo,
      synthesis: {
        async synthesize() {
          return [1, 2].map((index) => ({
            lane: "personal_story" as const,
            headline: `Same-story idea ${index}`,
            angle: `Angle ${index} on the same story`,
            why: ["Same underlying source"],
            evidence: [
              {
                kind: "source_post" as const,
                role: "inspiration" as const,
                label: "Same source",
                detail: "One source post, two angles",
                ref: "same-source",
                url: "https://example.com/same-source",
              },
              {
                kind: "knowledge" as const,
                role: "anchor" as const,
                label: "Same story",
                detail: "One user story, two angles",
                subtype: "story",
              },
            ],
            sourceKind: "source_post" as const,
            sourceRef: "same-source",
            sourceUrl: "https://example.com/same-source",
            sourceTitle: "Same source",
            sourcePublishedAt: null,
            score: 0.9,
            fingerprint: `same-story-${index}`,
            expiresAt: null,
          }));
        },
      },
      loadEvidence: async () => NEWS_EVIDENCE,
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
      idea("educational", {
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
              lane: "educational" as const,
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

  test("a source pitched on an earlier day is not pitched again", async () => {
    // Fingerprints only block an identical idea. The same story re-angled
    // under a new headline hashes differently, so without a source-level
    // window it returned the next day as though it were new.
    const yesterday = idea("educational", {
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
    const active = idea("educational");
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
    const active = idea("educational");
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
