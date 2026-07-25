/**
 * Stable data exchanged across the private phases of one Cowork turn.
 *
 * Keeping these protocol types free of setup/compiler implementations prevents
 * either phase from becoming the other's type owner.
 */
export type TurnContractKind =
  | "post"
  | "partial"
  | "research"
  | "saved_draft_action"
  | "answer";

export type TurnContract = {
  kind: TurnContractKind;
  expectedCount: number;
};

export type TurnContractDirectTask = {
  kind: string;
  expectedCount?: number;
};

export type BoardMoveStatus = "idea" | "drafting" | "ready";

export type ActionRequirement =
  | { type: "move_on_board"; status: BoardMoveStatus }
  | { type: "schedule_post"; date: string | null; timeZone?: string };

export type ActionOrchestratorRoute =
  | {
      kind: "action_management";
      targetCount: number;
      requirements: ActionRequirement[];
    }
  | {
      kind: "clarify_action";
      clarificationReason: "date" | "target_count" | "action";
      remainingClarifications?: Array<"date" | "target_count" | "action">;
      partialRequirements?: ActionRequirement[];
      partialTargetCount?: number | null;
    }
  | {
      kind: "no_action";
      noActionReason: "negated" | "informational" | "cancelled" | "mixed_count";
    }
  | {
      kind: "disallowed_action";
      disallowedReason: "publish" | "save" | "delete" | "posted";
    };

export type ActionOrchestratorRoutingInput = {
  userInstruction: string;
  isRefine: boolean;
  hasModelSource: boolean;
  hasAttachments: boolean;
  hasLeadMagnet: boolean;
  hasCreatorStyle: boolean;
  hasUnsavedDraftReferent?: boolean;
  clientTimezone?: string;
};

export type ChatTurnAttachment = {
  kind: "text" | "file" | "image";
  filename: string;
  text?: string;
  dataUrl?: string;
};
