import { localDateForInstant } from "@/lib/schedule-local-date";
import { truncateAtWordBoundary } from "@/lib/text-truncate";

export const AGENT_INBOX_LANES = ["now", "proven", "explore"] as const;
export type AgentInboxLane = (typeof AGENT_INBOX_LANES)[number];

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

export type AgentInboxEvidenceBundle = {
  news: AgentInboxEvidence[];
  learning: AgentInboxEvidence[];
  knowledge: AgentInboxEvidence[];
  recent?: AgentInboxEvidence[];
};

export type AgentInboxTransition =
  | { kind: "act" }
  | { kind: "discard"; reason?: string | null }
  | { kind: "snooze"; until: Date };

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
    skipped: "disabled" | "already_ran" | "full" | null;
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
      const occupied = new Set(retained.map((entry) => entry.lane));
      let missingLanes = AGENT_INBOX_LANES.filter(
        (lane) => !occupied.has(lane),
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
        const [evidence, recentFingerprints] = await Promise.all([
          loadEvidence({
            workspaceId,
            preferences,
            missingLanes,
            now,
          }),
          repository.readRecentFingerprints(
            workspaceId,
            new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000),
          ),
        ]);

        // "Now" is a promise of timeliness. Without verified, dated news it
        // remains honestly empty rather than turning into a generic idea.
        if (evidence.news.length === 0) {
          missingLanes = missingLanes.filter((lane) => lane !== "now");
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
        const allowed = new Set(missingLanes);
        const accepted: GeneratedAgentInboxIdea[] = [];
        const seen = new Set(recentFingerprints);
        for (const candidate of generated) {
          if (
            !allowed.has(candidate.lane) ||
            seen.has(candidate.fingerprint) ||
            accepted.some((entry) => entry.lane === candidate.lane)
          ) {
            continue;
          }
          if (
            candidate.lane === "now" &&
            !candidate.evidence.some((entry) => entry.kind === "news")
          ) {
            continue;
          }
          seen.add(candidate.fingerprint);
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
