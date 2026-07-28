import type { ExplorationLane } from "@/lib/content-learning/contracts";

export type { ExplorationLane } from "@/lib/content-learning/contracts";

function stableBucket(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 10;
}

export function automaticExplorationLane(seed: string): ExplorationLane {
  const bucket = stableBucket(seed);
  if (bucket < 6) return "familiar";
  if (bucket < 9) return "fresh";
  return "experimental";
}

const LANE_GUIDANCE: Record<ExplorationLane, string> = {
  familiar:
    "EXPLORATION LANE: FAMILIAR. Work within a topic or claim already well supported by the supplied request, Voice Profile, Workspace Knowledge, or Workspace Learning. Keep the expertise familiar, but use the recent draft excerpts to choose a materially different thesis, example, proof point, opening, or progression.",
  fresh:
    "EXPLORATION LANE: FRESH. Extend a supported idea into a neighboring problem, stage, audience question, implication, or use case that the recent drafts have not already covered. Keep a clear bridge to supplied evidence and the current request.",
  experimental:
    "EXPLORATION LANE: EXPERIMENTAL. Use a bolder but defensible framing, tension, opening pattern, or underused structure that still serves the current request. Stay anchored to supplied evidence and Voice Profile; surprising presentation does not permit unsupported claims.",
};

export function explorationLaneGuidance(lane: ExplorationLane): string {
  return [
    LANE_GUIDANCE[lane],
    "Do not invent facts, expertise, experiences, or results to satisfy this lane. Explicit user instructions, selected formats, and factuality rules always take priority.",
  ].join("\n");
}
