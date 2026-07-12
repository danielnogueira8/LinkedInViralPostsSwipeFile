export type DeliverableKind = "post" | "hook";

export type DeliverableContract = {
  kind: DeliverableKind;
  expectedCount: number;
};

export const DELIVERABLE_TOOL_BY_KIND = {
  post: "render_post",
  hook: "render_hook",
} as const satisfies Record<DeliverableKind, string>;

export function deliverableKindForTool(toolName: string): DeliverableKind | null {
  for (const [kind, mappedToolName] of Object.entries(DELIVERABLE_TOOL_BY_KIND)) {
    if (mappedToolName === toolName) return kind as DeliverableKind;
  }
  return null;
}

export type DeliverableArtifactDecision = {
  accept: boolean;
  reason?: "expected_post" | "expected_hook" | "count_complete";
};

export function deliverableProgress(
  contract: DeliverableContract,
  acceptedCount: number,
): { complete: boolean; remaining: number } {
  const remaining = Math.max(0, contract.expectedCount - acceptedCount);
  return { complete: remaining === 0, remaining };
}

const SUPPORTED_COUNTS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
};

// Intentionally narrow: a contract is created only when the user explicitly
// pairs an action, a supported count, and a renderable deliverable noun. Bare
// references such as "draft 5" remain in the ambiguity path.
const EXPLICIT_DELIVERABLE_RE =
  /^\s*(?:please\s+)?(?:write|draft|create|generate|make|produce|prepare|give\s+me|build)\s+(?:me\s+)?(?:exactly\s+)?(\d{1,2}|one|two|three|four|five|six)\s+(?:(?:finished|full|different|distinct)\s+)?(posts?|post\s+variations?|hooks?)\b/i;

export function deriveDeliverableContract(text: string): DeliverableContract | null {
  const match = text.match(EXPLICIT_DELIVERABLE_RE);
  if (!match) return null;
  // A correction or alternative after the matched command makes the requested
  // contract ambiguous. Fail open and let the agent interpret it instead of
  // deterministically locking onto the first clause.
  const remainder = text.slice((match.index ?? 0) + match[0].length);
  const matchedKind: DeliverableKind = /hook/i.test(match[2]) ? "hook" : "post";
  const namesOtherDeliverable =
    matchedKind === "hook" ? /\bposts?\b/i.test(remainder) : /\bhooks?\b/i.test(remainder);
  const namesAnotherDeliverable =
    /\b(?:\d{1,2}|one|two|three|four|five|six)\s+(?:posts?|post\s+variations?|hooks?)\b/i.test(
      remainder,
    );
  const correctsTheCommand =
    /(?:\b(?:actually|instead|rather)\b|\bno\s*,|\bor\s+(?:actually\s+)?(?:make\s+that|change|switch)\b|\b(?:make\s+that|change\s+that\s+to|switch\s+to)\s+(?:\d{1,2}|one|two|three|four|five|six)\b)/i.test(
      remainder,
    );
  if (namesOtherDeliverable || namesAnotherDeliverable || correctsTheCommand) {
    return null;
  }
  const count = /^\d+$/.test(match[1])
    ? Number(match[1])
    : SUPPORTED_COUNTS[match[1].toLowerCase()];
  if (!count || count > 6) return null;
  return {
    kind: matchedKind,
    expectedCount: count,
  };
}

export function evaluateDeliverableArtifact(
  contract: DeliverableContract,
  acceptedCount: number,
  candidateKind: DeliverableKind,
): DeliverableArtifactDecision {
  const progress = deliverableProgress(contract, acceptedCount);
  if (candidateKind !== contract.kind) {
    return {
      accept: false,
      reason: contract.kind === "hook" ? "expected_hook" : "expected_post",
    };
  }
  if (progress.complete) {
    return { accept: false, reason: "count_complete" };
  }
  return { accept: true };
}
