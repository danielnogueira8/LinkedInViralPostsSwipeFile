import { localDateForInstant } from "@/lib/schedule-local-date";
import { truncateAtWordBoundary } from "@/lib/text-truncate";

// Lanes are POST FRAMEWORKS, not evidence sources. The old now/proven/explore
// axis described where evidence came from, which let two cards share a
// framework and read as near-duplicates while sitting in different lanes.
// Naming the framework makes each lane a different KIND of post by
// construction. Newsjacking and namejacking remain available as intentional
// manual Cowork skills, but neither is a daily inbox lane.
export const AGENT_INBOX_LANES = [
  "personal_story",
  "educational",
] as const;
export type AgentInboxLane =
  | (typeof AGENT_INBOX_LANES)[number]
  // Legacy rows remain in the database for history and deduplication, but are
  // never generated or returned by the current inbox feed.
  | "newsjacking";
export type CurrentAgentInboxLane = (typeof AGENT_INBOX_LANES)[number];

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
  // Structured provenance lets the quality gate distinguish a verified story
  // from a generic knowledge item, and a well-sampled performance signal from
  // an attractive-looking single example.
  subtype?: string | null;
  confidence?: number | null;
  sampleSize?: number | null;
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
  readAt: string | null;
  createdAt: string;
  updatedAt: string;
};

// Trend Radar is discovered by the creator-independent scanner rather than
// the Agent Inbox replenishment run. It deliberately reuses the same card
// contract so the UI does not teach users that one agent is a second-class
// source with different controls.
export type AgentRadarIdea = Omit<AgentInboxIdea, "lane"> & {
  lane: "trend_radar";
  radar: true;
};

export const AGENT_FEED_LANES = [
  "trend_radar",
  ...AGENT_INBOX_LANES,
] as const;
export type AgentFeedLane = (typeof AGENT_FEED_LANES)[number];
export type CurrentAgentInboxIdea = Omit<AgentInboxIdea, "lane"> & {
  lane: CurrentAgentInboxLane;
};
export type AgentFeedIdea = CurrentAgentInboxIdea | AgentRadarIdea;

export function isCurrentAgentInboxLane(
  lane: AgentInboxLane,
): lane is CurrentAgentInboxLane {
  return (AGENT_INBOX_LANES as readonly string[]).includes(lane);
}

export function isCurrentAgentInboxIdea(
  idea: AgentInboxIdea,
): idea is CurrentAgentInboxIdea {
  return isCurrentAgentInboxLane(idea.lane);
}

// Message state is intentionally separate from the lifecycle status above.
// Reading an idea must not consume it: an active idea can be unread or read,
// while terminal outcomes retain their lifecycle label. Only an acted idea
// is shown as Done; discarded, archived, and expired ideas stay distinguishable.
export type AgentMessageState =
  | "unread"
  | "read"
  | "done"
  | "discarded"
  | "archived"
  | "expired";

export function agentMessageState(
  idea: Pick<AgentFeedIdea, "status" | "readAt">,
): AgentMessageState {
  if (idea.status === "active") return idea.readAt ? "read" : "unread";
  switch (idea.status) {
    case "acted":
      return "done";
    case "discarded":
      return "discarded";
    case "snoozed":
      return "archived";
    case "expired":
      return "expired";
  }
}

export function isAgentMessageUnread(
  idea: Pick<AgentFeedIdea, "status" | "readAt">,
): boolean {
  return agentMessageState(idea) === "unread";
}

export type GeneratedAgentInboxIdea = Omit<
  AgentInboxIdea,
  | "id"
  | "workspaceId"
  | "status"
  | "availableOn"
  | "snoozedUntil"
  | "actedAt"
  | "discardReason"
  | "readAt"
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

// How long an idea stays on the board before it expires on its own.
//
// Every lane expires. Before this, only newsjacking did — the evergreen lanes got
// a null expiry, so once a lane hit the 3-active cap it was permanently
// "full", never requested again, and the board froze. The daily run kept
// completing successfully while creating nothing, which is exactly what a
// stale inbox looks like from the outside.
//
// Newsjacking keeps the shortest fuse because a timely pitch genuinely rots.
// The evergreen lanes get longer ones — long enough that a card the user
// meant to act on is still there the next day, short enough that the board
// turns over without anyone having to clear it by hand.
export function laneLifetimeHours(lane: AgentInboxLane): number {
  switch (lane) {
    case "newsjacking":
      // Historical rows keep their original short expiry even though the lane
      // is no longer generated or shown in the current inbox.
      return 72;
    case "educational":
    case "personal_story":
      // Evergreen material, but the POINT is a fresh angle on it each week.
      return 168;
  }
}

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
    case "newsjacking":
      // Keep the legacy gate for persisted/test data. New inbox runs never
      // request this lane; direct Cowork newsjacking uses its own grounding
      // policy instead.
      return evidence.some(
        (entry) =>
          entry.kind === "news" &&
          Boolean(entry.url) &&
          Boolean(entry.publishedAt) &&
          Number.isFinite(Date.parse(entry.publishedAt ?? "")),
      );
    // The user's own material. `knowledge` is what the interview captured
    // (story / proof / belief); `voice` is how they tell it. Without one of
    // those there is no "your" in the story.
    case "personal_story":
      return evidence.some(
        (entry) =>
          entry.kind === "voice" ||
          (entry.kind === "knowledge" &&
            // Rows created before the subtype field shipped are still
            // verified knowledge. New rows always carry a subtype from the
            // knowledge table, so they get the stricter lane-specific gate.
            (!entry.subtype ||
              ["story", "belief", "proof"].includes(entry.subtype))),
      );
    // Expertise the user has actually demonstrated: measured performance, or
    // knowledge they approved. Anything else is a generic explainer.
    case "educational":
      return evidence.some(
        (entry) =>
          (entry.kind === "performance" &&
            // Legacy performance evidence has no reliability metadata; keep
            // it usable while enforcing both checks whenever the loader has
            // supplied them.
            (entry.confidence == null || entry.confidence >= 0.45) &&
            (entry.sampleSize == null || entry.sampleSize >= 3)) ||
          (entry.kind === "knowledge" &&
            (!entry.subtype ||
              ["proof", "topic_expertise", "offer"].includes(
                entry.subtype,
              ))),
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
  | { kind: "read" }
  | { kind: "unread" }
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
    skipped:
      | "disabled"
      | "already_ran"
      | "full"
      | "no_evidence"
      | "no_quality"
      | null;
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
  const index = AGENT_INBOX_LANES.indexOf(lane as CurrentAgentInboxLane);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
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
      const preferences = await repository.readPreferences(workspaceId);
      const localDate = localDateForInstant(
        now.toISOString(),
        preferences.timezone,
      );
      const [active, activity] = await Promise.all([
        repository
          .readActive(workspaceId, now)
          .then((ideas) => ideas.filter(isCurrentAgentInboxIdea)),
        repository
          .readRecentActivity(workspaceId, 12)
          .then((ideas) => ideas.filter(isCurrentAgentInboxIdea)),
      ]);
      return {
        // The inbox is a daily review surface. Older untouched ideas remain
        // persisted for deduplication and expiry, but they must not crowd out
        // the fresh batch the user expects to see each day.
        active: ordered(
          active.filter((entry) => entry.availableOn === localDate),
        ),
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
      const localDate = localDateForInstant(now.toISOString(), timezone);
      const activeIdeas = (await repository.readActive(workspaceId, now)).filter(
        isCurrentAgentInboxIdea,
      );
      const retained = ordered(
        activeIdeas.filter((entry) => entry.availableOn === localDate),
      );
      const activeCounts = new Map<AgentInboxLane, number>();
      for (const entry of retained) {
        activeCounts.set(entry.lane, (activeCounts.get(entry.lane) ?? 0) + 1);
      }
      const missingLanes = AGENT_INBOX_LANES.filter(
        (lane) =>
          (activeCounts.get(lane) ?? 0) < AGENT_INBOX_ACTIVE_PER_LANE,
      );
      if (missingLanes.length === 0) {
        return { created: [], retained, skipped: "full" };
      }

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
        const openSlots = new Map<AgentInboxLane, number>(
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
          ...activeIdeas
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
        if (created.length === 0) {
          // A model response can be syntactically valid yet fail the
          // deterministic evidence/deduplication gates. Do not mark that as
          // a successful daily run: the next cron tick should get another
          // chance once a better source appears or the model returns a
          // stronger lane-specific candidate.
          await repository.releaseDailyRun(workspaceId, localDate);
          return {
            created: [],
            retained,
            skipped: accepted.length > 0 ? "no_quality" : "no_evidence",
          };
        }
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
