import type { AgentInboxIdea, AgentInboxPreferences } from "@/lib/agent-inbox";

export type AgentInboxPayload = {
  ok: true;
  active: AgentInboxIdea[];
  activity: AgentInboxIdea[];
  preferences: AgentInboxPreferences;
};

let pendingAgentInboxPromise: Promise<AgentInboxPayload> | null = null;

function requestAgentInbox(): Promise<AgentInboxPayload> {
  return fetch("/api/agent/inbox", { cache: "no-store" }).then(
    async (response) => {
      const body = await response.json();
      if (!response.ok || !body.ok) {
        throw new Error(body.error || "Could not load your Agent.");
      }
      return body as AgentInboxPayload;
    },
  );
}

export function loadAgentInbox(): Promise<AgentInboxPayload> {
  pendingAgentInboxPromise ??= requestAgentInbox().catch((error) => {
    pendingAgentInboxPromise = null;
    throw error;
  });
  return pendingAgentInboxPromise;
}

export function invalidateAgentInboxRequest(): void {
  pendingAgentInboxPromise = null;
}
