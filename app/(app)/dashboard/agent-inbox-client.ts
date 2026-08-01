import type {
  AgentInboxIdea,
  AgentInboxPreferences,
  AgentRadarIdea,
} from "@/lib/agent-inbox";

export type AgentInboxPayload = {
  ok: true;
  active: AgentInboxIdea[];
  activity: AgentInboxIdea[];
  // Trend Radar is persisted by the creator-independent scanner, but the
  // inbox intentionally exposes it through the same feed response and card
  // contract as the four replenished lanes.
  trends: AgentRadarIdea[];
  trendActivity: AgentRadarIdea[];
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
