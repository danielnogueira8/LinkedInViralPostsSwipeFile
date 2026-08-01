import { z } from "zod";
import {
  BACKGROUND_MODEL,
  completeChat,
  logOpenRouterUsage,
  providerModelAttribution,
} from "@/lib/openrouter";
import { INJECTION_GUARD, wrapUntrustedXml } from "@/lib/agent/untrusted";
import { parseJsonObject } from "@/lib/claude";
import {
  STRUCTURE_CONTENT_TYPES,
  isStructureContentType,
  type StructureContentType,
} from "@/lib/templates";

// ---------------------------------------------------------------------------
// Idea brief compiler (PLAN-agent-loop Phase A1).
//
// One cheap BACKGROUND_MODEL call per user-initiated write turn with no
// explicit source. It turns free-text intent into a small, typed brief so the
// deterministic structure matcher can pick the best template / swipe post.
// Fail-open: any error, timeout, or malformed JSON returns null and the turn
// falls back to embedding-only structure matching.
// ---------------------------------------------------------------------------

export type IdeaBrief = {
  /** Detected arc of the requested post. */
  contentType: StructureContentType;
  /** The one-sentence claim the post will land. */
  coreClaim: string;
  /** The tone/register the post should be written in (e.g. "conversational", "analytical"). */
  register: string;
};

const IdeaBriefSchema = z.object({
  contentType: z.string(),
  coreClaim: z.string().trim(),
  register: z.string().trim(),
});

const IDEA_BRIEF_TIMEOUT_MS = 8_000;
const IDEA_BRIEF_MAX_TOKENS = 512;

export function coerceIdeaBrief(input: unknown): IdeaBrief | null {
  const parsed = IdeaBriefSchema.safeParse(input);
  if (!parsed.success) return null;
  return {
    contentType: isStructureContentType(parsed.data.contentType)
      ? parsed.data.contentType
      : "story",
    coreClaim: parsed.data.coreClaim.slice(0, 280),
    register: parsed.data.register.slice(0, 80),
  };
}

/**
 * Compile a short, typed brief from the user's free-text instruction.
 * Returns null on any failure so the caller can fall back to embedding-only
 * structure matching.
 */
export async function compileIdeaBrief(
  userText: string,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<IdeaBrief | null> {
  const trimmed = userText.trim();
  if (!trimmed) return null;

  try {
    const res = await completeChat({
      model: BACKGROUND_MODEL,
      maxTokens: IDEA_BRIEF_MAX_TOKENS,
      timeoutMs: IDEA_BRIEF_TIMEOUT_MS,
      messages: [
        {
          role: "system",
          content:
            `You categorize a LinkedIn post request into a brief. Output strict JSON only, no prose, in the shape: {"contentType": "...", "coreClaim": "...", "register": "..."}. ` +
            `contentType must be exactly one of: ${STRUCTURE_CONTENT_TYPES.join(", ")}. ` +
            `coreClaim is the single-sentence main point the post should land. ` +
            `register is the writing tone (e.g. conversational, analytical, vulnerable, punchy). ` +
            INJECTION_GUARD,
        },
        { role: "user", content: wrapUntrustedXml("request", trimmed) },
      ],
      signal,
    });
    const attribution = providerModelAttribution(BACKGROUND_MODEL, res.model);
    await logOpenRouterUsage(
      "idea_brief",
      attribution.model,
      res.usage,
      workspaceId,
      attribution.metadata,
    );
    const raw = res.text.trim();
    if (!raw) return null;
    const parsed = parseJsonObject(raw);
    return coerceIdeaBrief(parsed);
  } catch (error) {
    // Fail-open: the structure matcher still works without a brief.
    console.warn("compileIdeaBrief failed:", (error as Error).message);
    return null;
  }
}
