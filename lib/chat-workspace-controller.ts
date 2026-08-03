import type { ChatTurnRequest } from "@/lib/agent/chat-turn";
import type { ComposerStarterId } from "@/lib/composer-task-context";
import { consumeComposerExplorationLane } from "@/lib/chat-draft-storage";
import {
  commandForComposer,
  resumesPersistedCoworkOperation,
  type CoworkCommand,
  type CoworkComposerState,
} from "@/lib/cowork-command";
import {
  generationConfigForSelection,
  type DraftCountSelection,
  type ExplorationLaneSelection,
  type PostTypeSelection,
} from "@/lib/generation-config";

export type ChatWorkspaceSendOptions = {
  command?: CoworkCommand;
  retryOfUserMessageId?: string;
  actionSelectionIds?: string[];
  clarificationChoiceIndex?: number;
  clarificationAssistantMessageId?: string;
  isInterviewSubmission?: boolean;
};

type ComposerRequestFields = Pick<
  ChatTurnRequest,
  | "command"
  | "skillIds"
  | "contextPolicy"
  | "generationConfig"
  | "starterId"
  | "isInterviewSubmission"
>;

export type PrepareChatWorkspaceTurnInput = {
  composer: CoworkComposerState;
  draftCountSelection: DraftCountSelection;
  postTypeSelection: PostTypeSelection;
  explorationLaneSelection: ExplorationLaneSelection;
  starterId?: ComposerStarterId;
  skillIds: string[];
  hasPostFormat: boolean;
  hasCreatorStyle: boolean;
  askContextPostId?: string;
  hasPendingClarification?: boolean;
  sendOptions?: ChatWorkspaceSendOptions;
  isProgrammaticSend?: boolean;
};

export type PreparedChatWorkspaceTurn = {
  resumesPersistedOperation: boolean;
  appliesComposerControls: boolean;
  requestFields: ComposerRequestFields;
  composerAfterTurnStarts: CoworkComposerState | null;
  explorationLaneToRestore: ExplorationLaneSelection;
};

/**
 * Behavioral seam between the React workspace and the chat transport.
 *
 * The component owns presentation and transient picker state. This controller
 * owns the policy that turns those selections into one request, so the policy
 * can be exercised without reading or rendering the 8k-line client component.
 */
export interface ChatWorkspaceController {
  prepareTurn(
    input: PrepareChatWorkspaceTurnInput,
  ): PreparedChatWorkspaceTurn;
  consumeExplorationLane(
    turn: PreparedChatWorkspaceTurn,
    turnChatId: string,
    activeChatId: string | null,
  ): ExplorationLaneSelection | null;
}

export function createChatWorkspaceController(
  dependencies: {
    consumeExplorationLane?: typeof consumeComposerExplorationLane;
  } = {},
): ChatWorkspaceController {
  const consumeExplorationLane =
    dependencies.consumeExplorationLane ?? consumeComposerExplorationLane;

  return {
    prepareTurn(input) {
      const sendOptions = input.sendOptions;
      const resumesPersistedOperation =
        input.hasPendingClarification === true ||
        resumesPersistedCoworkOperation({
          ...(sendOptions?.retryOfUserMessageId
            ? { retryOfUserMessageId: sendOptions.retryOfUserMessageId }
            : {}),
          ...(sendOptions?.actionSelectionIds !== undefined
            ? { actionSelectionIds: sendOptions.actionSelectionIds }
            : {}),
          ...(sendOptions?.clarificationAssistantMessageId
            ? {
                clarificationAssistantMessageId:
                  sendOptions.clarificationAssistantMessageId,
              }
            : {}),
        });
      const appliesComposerControls =
        !input.isProgrammaticSend &&
        !resumesPersistedOperation &&
        !sendOptions?.command;

      const command = resumesPersistedOperation
        ? undefined
        : sendOptions?.command ??
          commandForComposer({
            kind: input.composer.kind,
            count:
              input.draftCountSelection === "auto"
                ? 1
                : input.draftCountSelection,
            ...(input.composer.kind === "ask" && input.askContextPostId
              ? { contextPostId: input.askContextPostId }
              : {}),
            ...(input.composer.kind === "edit" &&
            input.composer.targetPostId
              ? {
                  targetPostId: input.composer.targetPostId,
                  scope: input.composer.scope,
                }
              : {}),
          });

      const generationConfig =
        appliesComposerControls && command?.kind !== "edit"
          ? generationConfigForSelection(
              input.draftCountSelection,
              input.postTypeSelection,
              input.explorationLaneSelection,
            )
          : undefined;

      const requestFields: ComposerRequestFields = {
        ...(command ? { command } : {}),
        ...(input.skillIds.length ? { skillIds: input.skillIds } : {}),
        ...(appliesComposerControls
          ? {
              contextPolicy: {
                clear: [
                  ...(input.skillIds.length ? [] : ["skills" as const]),
                  ...(input.hasCreatorStyle
                    ? []
                    : ["creator_style" as const]),
                  ...(input.hasPostFormat ? [] : ["post_format" as const]),
                ],
              },
            }
          : {}),
        ...(generationConfig ? { generationConfig } : {}),
        ...(appliesComposerControls && input.starterId
          ? { starterId: input.starterId }
          : {}),
        ...(sendOptions?.isInterviewSubmission
          ? { isInterviewSubmission: true }
          : {}),
      };

      return {
        resumesPersistedOperation,
        appliesComposerControls,
        requestFields,
        composerAfterTurnStarts:
          command?.kind === "create"
            ? { kind: "create" }
            : command
              ? { kind: "ask" }
              : null,
        explorationLaneToRestore:
          generationConfig?.explorationLane ?? "auto",
      };
    },
    consumeExplorationLane(turn, turnChatId, activeChatId) {
      if (turn.requestFields.command?.kind !== "create") return null;
      return consumeExplorationLane(turnChatId, activeChatId);
    },
  };
}
