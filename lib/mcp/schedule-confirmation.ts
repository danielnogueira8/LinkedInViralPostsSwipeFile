import {
  acceptedContent,
  inputRequired,
  inputResponse,
  type CallToolResult,
  type InputRequiredResult,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  mcpRequestStateCodec,
  type McpRequestState,
} from "@/lib/mcp/request-state";

export type ScheduleDraftInput = Omit<McpRequestState, "flow">;

type ConfirmationOutcome =
  | { confirmed: true; input: ScheduleDraftInput }
  | {
      confirmed: false;
      result: CallToolResult | InputRequiredResult;
    };

const confirmationSchema = z.object({
  confirm: z.boolean(),
});

function errorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }],
  };
}

function cancelledResult(): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: false,
          cancelled: true,
          message: "Scheduling was cancelled. The draft was not changed.",
        }),
      },
    ],
  };
}

function confirmationMessage(input: ScheduleDraftInput): string {
  const instant = new Date(input.scheduled_at);
  const timezone = input.timezone || "UTC";
  let schedule = input.scheduled_at;
  try {
    schedule = new Intl.DateTimeFormat("en", {
      dateStyle: "full",
      timeStyle: "short",
      timeZone: timezone,
    }).format(instant);
  } catch {
    // Input validation normally prevents this; keep the ISO value as a safe
    // fallback for direct/internal callers.
  }
  return `Schedule this saved draft for ${schedule} (${timezone})?`;
}

function isScheduleState(value: unknown): value is McpRequestState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<McpRequestState>;
  return (
    state.flow === "schedule_draft" &&
    typeof state.id === "string" &&
    typeof state.scheduled_at === "string"
  );
}

function scheduleInputFromState(
  state: McpRequestState,
): ScheduleDraftInput {
  return {
    id: state.id,
    scheduled_at: state.scheduled_at,
    ...(state.plan_to_post_on !== undefined
      ? { plan_to_post_on: state.plan_to_post_on }
      : {}),
    ...(state.timezone !== undefined ? { timezone: state.timezone } : {}),
    ...(state.first_comment !== undefined
      ? { first_comment: state.first_comment }
      : {}),
  };
}

async function confirmationRequest(
  input: ScheduleDraftInput,
  context: ServerContext,
): Promise<ConfirmationOutcome> {
  const requestState = await mcpRequestStateCodec.mint(
    { flow: "schedule_draft", ...input },
    context,
  );
  return {
    confirmed: false,
    result: inputRequired({
      requestState,
      inputRequests: {
        schedule_confirmation: inputRequired.elicit({
          message: confirmationMessage(input),
          requestedSchema: {
            type: "object",
            properties: {
              confirm: {
                type: "boolean",
                title: "Schedule this draft",
                description:
                  "Confirm the LinkedIn publishing date and time shown above.",
              },
            },
            required: ["confirm"],
          },
        }),
      },
    }),
  };
}

/**
 * Production MCP requests confirm a real publishing mutation. Direct internal
 * invocations without an MCP request context retain their existing behavior.
 */
export async function confirmScheduleDraft(
  proposed: ScheduleDraftInput,
  context: ServerContext,
): Promise<ConfirmationOutcome> {
  if (!context.mcpReq) return { confirmed: true, input: proposed };

  const decodedState = context.mcpReq.requestState<McpRequestState>();
  if (!decodedState) return confirmationRequest(proposed, context);
  if (!isScheduleState(decodedState)) {
    return {
      confirmed: false,
      result: errorResult("This scheduling confirmation is invalid or expired."),
    };
  }

  const response = inputResponse(
    context.mcpReq.inputResponses,
    "schedule_confirmation",
  );
  if (
    response.kind === "elicit" &&
    (response.action === "decline" || response.action === "cancel")
  ) {
    return {
      confirmed: false,
      result: cancelledResult(),
    };
  }

  const accepted = acceptedContent(
    context.mcpReq.inputResponses,
    "schedule_confirmation",
    confirmationSchema,
  );
  if (accepted?.confirm === true) {
    return {
      confirmed: true,
      input: scheduleInputFromState(decodedState),
    };
  }
  if (accepted?.confirm === false) {
    return {
      confirmed: false,
      result: cancelledResult(),
    };
  }

  return confirmationRequest(
    scheduleInputFromState(decodedState),
    context,
  );
}
