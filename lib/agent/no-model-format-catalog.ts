export const NO_MODEL_FORMAT_CATALOG = [
  {
    id: "lead_magnet_system_breakdown",
    label: "Lead Magnet: System Breakdown",
    description: "For workflow, playbook, and system giveaways.",
  },
  {
    id: "lead_magnet_resource_inventory",
    label: "Lead Magnet: Resource Inventory",
    description: "For libraries, bundles, packs, and resource lists.",
  },
  {
    id: "personal_authority_story",
    label: "Personal Authority Story",
    description: "For lived lessons, personal updates, and founder stories.",
  },
  {
    id: "identity_belief_letter",
    label: "Identity / Belief Letter",
    description: "For audience beliefs, values, and identity tension.",
  },
  {
    id: "explainer_framework_breakdown",
    label: "Explainer / Framework Breakdown",
    description: "For concepts, frameworks, levels, and analogies.",
  },
  {
    id: "tactical_listicle",
    label: "Tactical Listicle",
    description: "For tips, steps, lessons, mistakes, and checklists.",
  },
  {
    id: "event_announcement",
    label: "Event / Announcement",
    description: "For launches, live sessions, webinars, and announcements.",
  },
  {
    id: "offer_proof_giveaway",
    label: "Offer / Proof / Giveaway Hybrid",
    description: "For proof-led resources, case studies, and offers.",
  },
  {
    id: "contrarian_take",
    label: "Contrarian Take",
    description: "For challenging a common belief or accepted advice.",
  },
  {
    id: "mistake_breakdown",
    label: "Mistake Breakdown",
    description: "For avoidable failures and tactical corrections.",
  },
  {
    id: "before_after_transformation",
    label: "Before / After Transformation",
    description: "For real turnarounds, changes, and journey posts.",
  },
] as const;

export type NoModelFormatId = (typeof NO_MODEL_FORMAT_CATALOG)[number]["id"];

export const NO_MODEL_FORMAT_IDS = NO_MODEL_FORMAT_CATALOG.map((f) => f.id) as [
  NoModelFormatId,
  ...NoModelFormatId[],
];

export function isNoModelFormatId(value: unknown): value is NoModelFormatId {
  return (
    typeof value === "string" &&
    NO_MODEL_FORMAT_IDS.includes(value as NoModelFormatId)
  );
}

export function noModelFormatLabel(id: NoModelFormatId): string {
  return NO_MODEL_FORMAT_CATALOG.find((f) => f.id === id)?.label ?? id;
}
