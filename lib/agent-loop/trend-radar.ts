// Compatibility exports for callers that still import the pre-split scanner.
// The current web-backed implementation lives in newsjacking.ts. This module
// becomes the creator-cluster Trend Radar implementation in the next rollout
// step.
export {
  buildNewsjackingQuery as buildTrendRadarQuery,
  hasCreatorCoverage,
  newsjackingEvidenceText as trendEvidenceText,
  newsjackingKeyForResult as trendKeyForResult,
  newsjackingOperationKey as trendRadarOperationKey,
  newsjackingOpportunityPayload as trendOpportunityPayload,
  rankNewsjackingCandidates as rankTrendCandidates,
  scanNewsjackingOpportunities as scanTrendOpportunities,
  scoreNewsjackingSignal as scoreTrendSignal,
} from "@/lib/agent-loop/newsjacking";
export type {
  NewsjackingCandidate as TrendCandidate,
  NewsjackingOpportunityPayload as TrendOpportunityPayload,
  ScanNewsjackingOptions as ScanTrendRadarOptions,
  ScanNewsjackingResult as ScanTrendRadarResult,
} from "@/lib/agent-loop/newsjacking";
