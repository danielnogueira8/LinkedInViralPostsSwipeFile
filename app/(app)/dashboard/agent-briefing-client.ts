"use client";

export type AgentBriefingPayload = {
  ok?: boolean;
  drafts?: unknown;
  opportunities?: unknown;
};

let pendingBriefingPromise: Promise<AgentBriefingPayload> | null = null;

function fetchAgentBriefing(): Promise<AgentBriefingPayload> {
  return fetch("/api/agent/briefing", { cache: "no-store" })
    .then((response) => response.json())
    .catch(() => ({}));
}

export function loadAgentBriefing(): Promise<AgentBriefingPayload> {
  pendingBriefingPromise ??= fetchAgentBriefing();
  const request = pendingBriefingPromise;
  const clear = () => {
    if (pendingBriefingPromise === request) pendingBriefingPromise = null;
  };
  void request.then(clear, clear);
  return request;
}

export function invalidateAgentBriefingRequest(): void {
  pendingBriefingPromise = null;
}
