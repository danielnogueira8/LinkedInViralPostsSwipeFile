import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import {
  chatTurnRequestSchema,
  executeChatTurn,
  jsonError,
} from "@/lib/agent/chat-turn";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";
export const maxDuration = 300;

type ChatStreamRouteDependencies = {
  authenticate: () => Promise<{ userId: string | null }>;
  execute: typeof executeChatTurn;
};

/**
 * Keep the public HTTP seam identical in production while allowing the
 * reliability harness to adapt only authentication and turn execution. The
 * injected executor still runs the real ChatTurn module; tests do not need a
 * special route, environment flag, or production-only branch.
 */
export function createChatStreamPost(
  dependencies: Partial<ChatStreamRouteDependencies> = {},
) {
  const authenticate = dependencies.authenticate ?? auth;
  const execute = dependencies.execute ?? executeChatTurn;

  return async function post(
    req: Request,
    { params }: { params: Promise<{ id: string }> },
  ) {
    let userId: string | null;
    try {
      userId = (await authenticate()).userId;
    } catch (error) {
      return errorResponse(error);
    }
    if (!userId) return jsonError("Sign in required", 401);

    let body: z.infer<typeof chatTurnRequestSchema>;
    try {
      body = chatTurnRequestSchema.parse(await req.json());
    } catch (error) {
      if (error instanceof z.ZodError)
        return jsonError("Invalid request body", 400);
      return errorResponse(error);
    }

    let chatId: string;
    try {
      ({ id: chatId } = await params);
    } catch (error) {
      return errorResponse(error);
    }
    let result: Awaited<ReturnType<typeof executeChatTurn>>;
    try {
      result = await execute({
        chatId,
        userId,
        body,
        signal: req.signal,
      });
    } catch (error) {
      return errorResponse(error);
    }
    if (result instanceof Response) return result;

    return new Response(result.stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        ...(result.claimedTurnStartedAt
          ? { "X-Turn-Started-At": result.claimedTurnStartedAt }
          : {}),
        ...(result.claimedUserMessageId
          ? { "X-User-Message-Id": result.claimedUserMessageId }
          : {}),
      },
    });
  };
}

export const POST = createChatStreamPost();
