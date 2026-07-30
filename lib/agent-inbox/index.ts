import { localDateForInstant } from "@/lib/schedule-local-date";
import { truncateAtWordBoundary } from "@/lib/text-truncate";

// Lanes are POST FRAMEWORKS, not evidence sources. The old now/proven/explore
// axis described where evidence came from, which let two cards share a
// framework and read as near-duplicates while sitting in different lanes.
// Naming the framework makes each lane a different KIND of post by
// construction, and maps 1:1 onto the skills that already exist.
export const AGENT_INBOX_LANES = [
  "newsjacking",
  "personal_story",
  "namejacking",
  "educational",
] as const;
export type AgentInboxLane = (typeof AGENT_INBOX_LANES)[number];

// Up to three active ideas per lane — quality-gated, so a lane may hold
// fewer when the evidence is weak. Never pad a lane to reach this cap.
export const AGENT_INBOX_ACTIVE_PER_LANE = 3;

export const AGENT_INBOX_STATUSES = [
  "active",
  "acted",
  "discarded",
  "snoozed",
  "expired",
] as const;
export type AgentInboxStatus = (typeof AGENT_INBOX_STATUSES)[number];

export type AgentInboxEvidence = {
  kind: "news" | "performance" | "knowledge" | "source_post" | "voice";
  label: string;
  detail: string;
  url?: string | null;
  publishedAt?: string | null;
  ref?: string | null;
};

export type AgentInboxIdea = {
  id: string;
  workspaceId: string;
  lane: AgentInboxLane;
  status: AgentInboxStatus;
  headline: string;
  angle: string;
  why: string[];
  evidence: AgentInboxEvidence[];
  sourceKind: "news" | "workspace_learning" | "knowledge" | "source_post";
  sourceRef: string | null;
  sourceUrl: string | null;
  sourceTitle: string | null;
  sourcePublishedAt: string | null;
  score: number;
  fingerprint: string;
  availableOn: string;
  expiresAt: string | null;
  snoozedUntil: string | null;
  actedAt: string | null;
  discardReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GeneratedAgentInboxIdea = Omit<
  AgentInboxIdea,
  | "id"
  | "workspaceId"
  | "status"
  | "availableOn"
  | "snoozedUntil"
  | "actedAt"
  | "discardReason"
  | "createdAt"
  | "updatedAt"
>;

export type AgentInboxPreferences = {
  enabled: boolean;
  timezone: string;
  deliveryLocalTime: string;
  topics: string[];
  newsSensitivity: "low" | "standard" | "high";
};

// Each lane is a different KIND of post, so each needs a different kind of
// raw material. This is the gate that keeps a lane honest: a "your story" card
// built from a news article is not a personal story, it is a news card wearing
// the wrong label — and shipping one teaches the user the lanes mean nothing.
//
// A lane whose requirement is unmet stays EMPTY. That mirrors the existing
// newsjacking rule (no verified news → no card) and is the same trade
// throughout: an empty lane is honest, a mislabelled card is not.
export function laneEvidenceSatisfied(
  lane: AgentInboxLane,
  evidence: readonly AgentInboxEvidence[],
): boolean {
  switch (lane) {
    // A timely pitch has to be anchored to a dated story — that is the whole
    // claim it makes.
    case "newsjacking":
      return evidence.some((entry) => entry.kind === "news");
    // The user's own material. `knowledge` is what the interview captured
    // (story / proof / belief); `voice` is how they tell it. Without one of
    // those there is no "your" in the story.
    case "personal_story":
      return evidence.some(
        (entry) => entry.kind === "knowledge" || entry.kind === "voice",
      );
    // Borrowing attention needs someone to borrow it FROM, and the named
    // person or company only ever arrives on a news item.
    case "namejacking":
      return evidence.some((entry) => entry.kind === "news");
    // Expertise the user has actually demonstrated: measured performance, or
    // knowledge they approved. Anything else is a generic explainer.
    case "educational":
      return evidence.some(
        (entry) =>
          entry.kind === "performance" ||
          entry.kind === "knowledge" ||
          entry.kind === "source_post",
      );
  }
}

export type AgentInboxEvidenceBundle = {
  news: AgentInboxEvidence[];
  learning: AgentInboxEvidence[];
  knowledge: AgentInboxEvidence[];
  recent?: AgentInboxEvidence[];
};

export type AgentInboxTransition =
  | { kind: "act" }
  | { kind: "discard"; reason?: string | null }
  | { kind: "snooze"; until: Date }
  // Reverse a just-acted idea when the Cowork handoff failed. Bounded to a
  // short window server-side, and never applies to a discarded idea.
  | { kind: "restore" };

export type AgentInboxRepository = {
  readActive(workspaceId: string, now: Date): Promise<AgentInboxIdea[]>;
  readRecentActivity(
    workspaceId: string,
    limit: number,
  ): Promise<AgentInboxIdea[]>;
  readRecentFingerprints(
    workspaceId: string,
    since: Date,
  ): Promise<Set<string>>;
  readRecentSources(workspaceId: string, since: Date): Promise<Set<string>>;
  releaseDueSnoozed(workspaceId: string, now: Date): Promise<void>;
  claimDailyRun(
    workspaceId: string,
    localDate: string,
    timezone: string,
    lanes: AgentInboxLane[],
  ): Promise<boolean>;
  completeDailyRun(
    workspaceId: string,
    localDate: string,
    ideaIds: string[],
  ): Promise<void>;
  // Give a claim back without marking the day done, so a run that found no
  // evidence to work with can be retried by a later tick.
  releaseDailyRun(workspaceId: string, localDate: string): Promise<void>;
  failDailyRun(
    workspaceId: string,
    localDate: string,
    message: string,
  ): Promise<void>;
  insertIdeas(
    workspaceId: string,
    ideas: GeneratedAgentInboxIdea[],
    localDate: string,
  ): Promise<AgentInboxIdea[]>;
  transition(
    workspaceId: string,
    ideaId: string,
    action: AgentInboxTransition,
  ): Promise<AgentInboxIdea | null>;
  readPreferences(workspaceId: string): Promise<AgentInboxPreferences>;
};

export type AgentInboxSynthesis = {
  synthesize(input: {
    workspaceId: string;
    lanes: AgentInboxLane[];
    evidence: AgentInboxEvidenceBundle;
    recentFingerprints: Set<string>;
    preferences: AgentInboxPreferences;
    now: Date;
  }): Promise<GeneratedAgentInboxIdea[]>;
};

export type AgentInbox = {
  read(
    workspaceId: string,
    now: Date,
  ): Promise<{
    active: AgentInboxIdea[];
    activity: AgentInboxIdea[];
    preferences: AgentInboxPreferences;
  }>;
  replenish(input: {
    workspaceId: string;
    now: Date;
    timezone: string;
  }): Promise<{
    created: AgentInboxIdea[];
    retained: AgentInboxIdea[];
    skipped: "disabled" | "already_ran" | "full" | "no_evidence" | null;
  }>;
  transition(input: {
    workspaceId: string;
    ideaId: string;
    action: AgentInboxTransition;
  }): Promise<AgentInboxIdea | null>;
};

type AgentInboxDependencies = {
  repository: AgentInboxRepository;
  synthesis: AgentInboxSynthesis;
  loadEvidence(input: {
    workspaceId: string;
    preferences: AgentInboxPreferences;
    missingLanes: AgentInboxLane[];
    now: Date;
  }): Promise<AgentInboxEvidenceBundle>;
};

// A source is off-limits for a fortnight after it is pitched. Fingerprints
// already block an identical idea for 90 days, but a story re-angled under a
// new headline hashes differently — so without a source-level window the same
// article can come back the next day as though it were new. Two weeks is short
// enough that a genuinely evergreen source post can be revisited later.
const RECENT_SOURCE_WINDOW_DAYS = 14;
const RECENT_SOURCE_SINCE = (now: Date) =>
  new Date(now.getTime() - RECENT_SOURCE_WINDOW_DAYS * 24 * 60 * 60 * 1000);

function laneOrder(lane: AgentInboxLane): number {
  return AGENT_INBOX_LANES.indexOf(lane);
}

function ordered(ideas: AgentInboxIdea[]): AgentInboxIdea[] {
  return [...ideas].sort(
    (left, right) =>
      laneOrder(left.lane) - laneOrder(right.lane) ||
      right.createdAt.localeCompare(left.createdAt),
  );
}

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (
    truncateAtWordBoundary(message.replace(/\s+/g, " ").trim(), 240) ||
    "Unknown failure"
  );
}

export function createAgentInbox(
  dependencies: AgentInboxDependencies,
): AgentInbox {
  const { repository, synthesis, loadEvidence } = dependencies;
  return {
    async read(workspaceId, now) {
      await repository.releaseDueSnoozed(workspaceId, now);
      const [active, activity, preferences] = await Promise.all([
        repository.readActive(workspaceId, now),
        repository.readRecentActivity(workspaceId, 12),
        repository.readPreferences(workspaceId),
      ]);
      return {
        active: ordered(active),
        activity,
        preferences,
      };
    },

    async replenish({ workspaceId, now, timezone }) {
      const preferences = await repository.readPreferences(workspaceId);
      if (!preferences.enabled) {
        return { created: [], retained: [], skipped: "disabled" };
      }
      await repository.releaseDueSnoozed(workspaceId, now);
      const retained = ordered(await repository.readActive(workspaceId, now));
      const activeCounts = new Map<AgentInboxLane, number>();
      for (const entry of retained) {
        activeCounts.set(entry.lane, (activeCounts.get(entry.lane) ?? 0) + 1);
      }
      let missingLanes = AGENT_INBOX_LANES.filter(
        (lane) =>
          (activeCounts.get(lane) ?? 0) < AGENT_INBOX_ACTIVE_PER_LANE,
      );
      if (missingLanes.length === 0) {
        return { created: [], retained, skipped: "full" };
      }

      const localDate = localDateForInstant(now.toISOString(), timezone);
      const claimed = await repository.claimDailyRun(
        workspaceId,
        localDate,
        timezone,
        missingLanes,
      );
      if (!claimed) {
        return { created: [], retained, skipped: "already_ran" };
      }

      try {
        const dedupeSince = new Date(
          now.getTime() - 90 * 24 * 60 * 60 * 1000,
        );
        const [evidence, recentFingerprints, recentSources] = await Promise.all(
          [
            loadEvidence({
              workspaceId,
              preferences,
              missingLanes,
              now,
            }),
            repository.readRecentFingerprints(workspaceId, dedupeSince),
            repository.readRecentSources(workspaceId, RECENT_SOURCE_SINCE(now)),
          ],
        );

        // Newsjacking is a promise of timeliness. Without verified, dated news
        // it stays honestly empty rather than turning into a generic idea.
        if (evidence.news.length === 0) {
          missingLanes = missingLanes.filter(
            (lane) => lane !== "newsjacking",
          );
          // Nothing else was outstanding, so this run did no work. Releasing
          // the claim lets a later tick try again once news breaks — holding it
          // would mark the day done and leave `now` empty until local midnight.
          if (missingLanes.length === 0) {
            await repository.releaseDailyRun(workspaceId, localDate);
            return { created: [], retained, skipped: "no_evidence" };
          }
        }

        const generated =
          missingLanes.length === 0
            ? []
            : await synthesis.synthesize({
                workspaceId,
                lanes: missingLanes,
                evidence,
                recentFingerprints,
                preferences,
                now,
              });
        // Each missing lane keeps only its remaining open slots: lanes that
        // already hold active ideas top up, they never overflow the cap.
        const openSlots = new Map(
          missingLanes.map((lane) => [
            lane,
            AGENT_INBOX_ACTIVE_PER_LANE - (activeCounts.get(lane) ?? 0),
          ]),
        );
        const accepted: GeneratedAgentInboxIdea[] = [];
        const acceptedCounts = new Map<AgentInboxLane, number>();
        const seen = new Set(recentFingerprints);
        // One idea per source per run: two cards built on the same news story
        // (or the same performance signal) read as the agent repeating itself.
        // Seeded with both the sources already on the board and those pitched
        // in the recent past, so neither a top-up run nor tomorrow's run can
        // re-pitch a story the user has already been shown.
        const usedSources = new Set([
          ...retained
            .map((entry) => entry.sourceUrl ?? entry.sourceRef)
            .filter((value): value is string => Boolean(value)),
          ...recentSources,
        ]);
        for (const candidate of generated) {
          const remaining = openSlots.get(candidate.lane);
          const sourceKey = candidate.sourceUrl ?? candidate.sourceRef;
          if (
            remaining === undefined ||
            seen.has(candidate.fingerprint) ||
            (acceptedCounts.get(candidate.lane) ?? 0) >= remaining ||
            (sourceKey !== null && usedSources.has(sourceKey))
          ) {
            continue;
          }
          if (
            !laneEvidenceSatisfied(candidate.lane, candidate.evidence)
          ) {
            continue;
          }
          seen.add(candidate.fingerprint);
          if (sourceKey !== null) usedSources.add(sourceKey);
          acceptedCounts.set(
            candidate.lane,
            (acceptedCounts.get(candidate.lane) ?? 0) + 1,
          );
          accepted.push(candidate);
        }

        const created = await repository.insertIdeas(
          workspaceId,
          accepted,
          localDate,
        );
        await repository.completeDailyRun(
          workspaceId,
          localDate,
          created.map((entry) => entry.id),
        );
        return { created: ordered(created), retained, skipped: null };
      } catch (error) {
        await repository.failDailyRun(
          workspaceId,
          localDate,
          cleanError(error),
        );
        throw error;
      }
    },

    transition({ workspaceId, ideaId, action }) {
      return repository.transition(workspaceId, ideaId, action);
    },
  };
}
