import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import {
  chatTurnRequestSchema,
  executeChatTurn,
  jsonError,
} from "@/lib/agent/chat-turn";

export {
  applyCiteSourceToDraftArtifacts,
  chatHistoryWithModelSources,
  chatRejectLogLine,
  creatorStyleToolCall,
  customSkillsToolCall,
  extractLeadMagnetSelection,
  extractModelSourceId,
  firstSourceImage,
  isBatchArtifactFilingRow,
  latestDraftForVariation,
  latestLeadMagnetSelection,
  leadMagnetToolCall,
  modelSourceEnvelope,
  modelSourceToolCall,
  postFormatToolCall,
  reusableManualLeadMagnetIdForTurn,
  shouldApplyLeadMagnetContext,
  sourceMediaCanRenderAsImage,
  sourceReferenceFromCiteArtifact,
  tagArtifactWithCreatorStyle,
  tagArtifactWithLeadMagnet,
  tagArtifactWithModelSourceReference,
  tagArtifactWithNoModelFormat,
  tagArtifactWithSkills,
  validateChatAttachment,
  withLeadMagnetImagePlanStep,
  withLeadMagnetResourcePlanStep,
} from "@/lib/agent/chat-turn";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = (await auth()).userId;
  if (!userId) return jsonError("Sign in required", 401);

  let body: z.infer<typeof chatTurnRequestSchema>;
  try {
    body = chatTurnRequestSchema.parse(await req.json());
  } catch (error) {
    if (error instanceof z.ZodError)
      return jsonError("Invalid request body", 400);
    return jsonError((error as Error)?.message ?? "Unexpected error", 500);
  }

  const { id: chatId } = await params;
  const result = await executeChatTurn({
    chatId,
    userId,
    body,
    signal: req.signal,
  });
  if (result instanceof Response) return result;

  return new Response(result.stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      ...(result.claimedTurnStartedAt
        ? { "X-Turn-Started-At": result.claimedTurnStartedAt }
        : {}),
    },
  });
}
