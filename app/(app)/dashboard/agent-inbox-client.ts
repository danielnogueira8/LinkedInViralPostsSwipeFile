import type {
  AgentFeedLane,
  AgentInboxIdea,
  AgentInboxPreferences,
  AgentRadarIdea,
} from "@/lib/agent-inbox";

export type AgentInboxPayload = {
  ok: true;
  active: AgentInboxIdea[];
  activity: AgentInboxIdea[];
  // Both external discovery agents are persisted by the scheduled scanners,
  // but the inbox exposes them through the same feed response and card
  // contract as the replenished lanes.
  trends: AgentRadarIdea[];
  trendActivity: AgentRadarIdea[];
  newsjacking: AgentRadarIdea[];
  newsjackingActivity: AgentRadarIdea[];
  preferences: AgentInboxPreferences;
};

let pendingAgentInboxPromise: Promise<AgentInboxPayload> | null = null;
let pendingAgentInboxRecoveryPromise: Promise<AgentInboxPayload> | null = null;

function requestAgentInbox(replenish: boolean): Promise<AgentInboxPayload> {
  const query = replenish ? "?replenish=1" : "";
  return fetch(`/api/agent/inbox${query}`, { cache: "no-store" }).then(
    async (response) => {
      const body = await response.json();
      if (!response.ok || !body.ok) {
        throw new Error(body.error || "Could not load your Agent.");
      }
      return body as AgentInboxPayload;
    },
  );
}

export async function completeAgentInboxHandoff(
  ideaId: string,
  lane: AgentFeedLane,
): Promise<void> {
  const radar = lane === "trend_radar" || lane === "newsjacking";
  const response = await fetch(
    radar
      ? `/api/agent/opportunities/${ideaId}`
      : `/api/agent/inbox/ideas/${ideaId}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        radar ? { action: "handled" } : { kind: "done" },
      ),
    },
  );
  const body = (await response.json()) as {
    ok?: boolean;
    error?: string;
  };
  if (!response.ok || body.ok !== true) {
    throw new Error(body.error || "Could not mark this recommendation done.");
  }
}

export function loadAgentInbox(options?: {
  replenish?: boolean;
}): Promise<AgentInboxPayload> {
  const replenish = options?.replenish === true;
  const pending = replenish
    ? pendingAgentInboxRecoveryPromise
    : pendingAgentInboxPromise;
  if (pending) return pending;

  const request = requestAgentInbox(replenish).catch((error) => {
    if (replenish) {
      pendingAgentInboxRecoveryPromise = null;
    } else {
      pendingAgentInboxPromise = null;
    }
    throw error;
  });
  if (replenish) {
    pendingAgentInboxRecoveryPromise = request;
  } else {
    pendingAgentInboxPromise = request;
  }
  return request;
}

export function invalidateAgentInboxRequest(): void {
  pendingAgentInboxPromise = null;
  pendingAgentInboxRecoveryPromise = null;
}
