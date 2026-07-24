import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { chatTurnRequestSchema, jsonError } from "@/lib/agent/chat-turn";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import {
  resolveTurnDecision,
  productionResolveDecisionDeps,
  type ResolveDecisionDeps,
} from "@/lib/agent/turn/resolve-decision";

export const runtime = "nodejs";
export const maxDuration = 15;

type ResolveRouteDependencies = {
  authenticate: () => Promise<{ userId: string | null }>;
  resolveWorkspaceId: () => Promise<string>;
  resolve: typeof resolveTurnDecision;
  resolveDeps: ResolveDecisionDeps;
};

/**
 * Dry-run "confirm before generating" resolver. Returns the RESOLVED routing
 * decision for a chat-turn request (mode, count, niche, post type, source)
 * without claiming a turn, persisting a message, or running the model — so the
 * composer can show the user exactly what will happen before they commit. Uses
 * the same request schema as the stream endpoint and the same
 * resolvePreclaimRouting + compileServerReadOnlyPlan the live turn runs.
 */
export function createChatResolvePost(
  dependencies: Partial<ResolveRouteDependencies> = {},
) {
  const authenticate = dependencies.authenticate ?? auth;
  const resolveWorkspaceId =
    dependencies.resolveWorkspaceId ??
    (async () => (await scopedSupabase()).workspaceId);
  const resolve = dependencies.resolve ?? resolveTurnDecision;
  const resolveDeps = dependencies.resolveDeps ?? productionResolveDecisionDeps;

  return async function post(req: Request) {
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

    let workspaceId: string;
    try {
      workspaceId = await resolveWorkspaceId();
    } catch (error) {
      return errorResponse(error);
    }

    try {
      const decision = await resolve(body, workspaceId, resolveDeps);
      return Response.json({ ok: true, decision });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export const POST = createChatResolvePost();
