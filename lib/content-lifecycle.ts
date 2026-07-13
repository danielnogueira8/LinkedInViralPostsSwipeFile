export const CONTENT_LIFECYCLE_STAGES = {
  idea: "Inspiration",
  drafting: "Draft",
  ready: "Ready",
  scheduled: "Scheduled",
  posted: "Published",
} as const;

export const CONTENT_LIFECYCLE = [
  CONTENT_LIFECYCLE_STAGES.idea,
  CONTENT_LIFECYCLE_STAGES.drafting,
  CONTENT_LIFECYCLE_STAGES.ready,
  CONTENT_LIFECYCLE_STAGES.scheduled,
  CONTENT_LIFECYCLE_STAGES.posted,
] as const;

export const PUBLIC_DRAFT_STATUS_LABELS = {
  idea: CONTENT_LIFECYCLE_STAGES.idea,
  drafting: CONTENT_LIFECYCLE_STAGES.drafting,
  ready: CONTENT_LIFECYCLE_STAGES.ready,
  posted: CONTENT_LIFECYCLE_STAGES.posted,
} as const;

export const PUBLIC_DRAFT_STATUS_HELP = {
  idea: "Inspiration: a saved angle or hook that still needs drafting.",
  drafting: "Draft: work in progress, not ready to publish yet.",
  ready: "Ready: reviewed and ready for a publish time.",
  posted: "Published: live on LinkedIn or archived as completed work.",
} as const;
