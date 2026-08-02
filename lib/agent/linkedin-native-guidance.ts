import type { AdapterHealthRegistry } from "@/lib/agent/adapter-health";
import type { CoworkTurnTelemetry } from "@/lib/agent/cowork-telemetry";
import {
  buildExemplarBlock,
  type RetrievedExemplar,
} from "@/lib/batch/exemplar-retrieval";
import {
  loadNoModelFormatExamples,
  renderNoModelFormatBlock,
  selectNoModelFormatForTurn,
  type NoModelExample,
  type NoModelFormat,
} from "@/lib/agent/no-model-formats";
import {
  isLeadMagnetNoModelFormat,
  type NoModelFormatId,
} from "@/lib/agent/no-model-format-catalog";
import { explicitlyForbidsSourceDiscovery } from "@/lib/agent/source-policy";
import type { PostType } from "@/lib/post-type";

export const LINKEDIN_NATIVE_GUIDANCE_MAX_CHARS = 12_000;
// Cosine similarity from match_post_embeddings is already ordered nearest-first.
// This floor prevents a merely non-empty ANN result from displacing the curated
// fallback when the corpus has no genuinely topic-relevant positive exemplar.
export const LINKEDIN_NATIVE_MIN_SIMILARITY = 0.75;

export type LinkedInNativeGuidanceExemplar = {
  postId: string;
  text: string;
  similarity: number | null;
  source: "semantic" | "curated";
};

export type LinkedInNativeGuidance = {
  format: NoModelFormat;
  promptBlock: string;
  exemplars: LinkedInNativeGuidanceExemplar[];
  retrievalMode:
    | "semantic"
    | "curated"
    | "rules_only"
    | "disabled"
    | "opted_out";
};

export type ResolveLinkedInNativeGuidanceInput = {
  workspaceId: string;
  instruction: string;
  forcedFormatId?: NoModelFormatId;
  postType?: PostType | null;
  signal?: AbortSignal;
  telemetry?: CoworkTurnTelemetry;
  adapterHealth?: AdapterHealthRegistry;
};

function semanticExemplars(
  exemplars: RetrievedExemplar[],
): LinkedInNativeGuidanceExemplar[] {
  return exemplars.map((exemplar) => ({
    postId: exemplar.postId,
    text: exemplar.text,
    similarity: exemplar.similarity,
    source: "semantic",
  }));
}

function curatedExemplars(
  exemplars: NoModelExample[],
): LinkedInNativeGuidanceExemplar[] {
  return exemplars.map((exemplar) => ({
    postId: exemplar.id,
    text: exemplar.text,
    similarity: null,
    source: "curated",
  }));
}

function boundedPromptBlock(block: string): string {
  if (block.length <= LINKEDIN_NATIVE_GUIDANCE_MAX_CHARS) return block;
  // Keep the deterministic format rules intact. If the retrieved examples ever
  // exceed the budget, omit the untrusted examples rather than cutting through
  // an envelope marker and creating an ambiguous prompt boundary.
  const exampleStart = [
    "\n\nReal LinkedIn examples to study",
    "\n\nFor reference, here is how similar topics have performed",
  ]
    .map((marker) => block.indexOf(marker))
    .filter((index) => index > 0)
    .sort((a, b) => a - b)[0];
  if (exampleStart !== undefined) return block.slice(0, exampleStart).trim();
  return block.slice(0, LINKEDIN_NATIVE_GUIDANCE_MAX_CHARS).trim();
}

function semanticEnabled(): boolean {
  return process.env.LINKEDIN_NATIVE_RAG_ENABLED !== "false";
}

function postTypeForFormat(format: NoModelFormat): PostType {
  return isLeadMagnetNoModelFormat(format.id) ? "lead_magnet" : "regular";
}

function semanticPromptBlock(
  format: NoModelFormat,
  exemplarBlock: string,
): string {
  return boundedPromptBlock(
    [renderNoModelFormatBlock(format, []), exemplarBlock.trim()]
      .filter(Boolean)
      .join("\n\n"),
  );
}

function guidanceFromSemantic(
  format: NoModelFormat,
  block: {
    block: string;
    exemplars: RetrievedExemplar[];
  },
): LinkedInNativeGuidance {
  const exemplars = semanticExemplars(block.exemplars);
  return {
    format,
    promptBlock: semanticPromptBlock(format, block.block),
    exemplars,
    retrievalMode: "semantic",
  };
}

function guidanceFromCurated(
  format: NoModelFormat,
  examples: NoModelExample[],
): LinkedInNativeGuidance {
  const exemplars = curatedExemplars(examples);
  return {
    format,
    promptBlock: boundedPromptBlock(renderNoModelFormatBlock(format, examples)),
    exemplars,
    retrievalMode: "curated",
  };
}

export async function resolveLinkedInNativeGuidance(
  input: ResolveLinkedInNativeGuidanceInput,
): Promise<LinkedInNativeGuidance> {
  const format = selectNoModelFormatForTurn(
    input.instruction,
    input.forcedFormatId,
  );
  const rulesOnly = (): LinkedInNativeGuidance => ({
    format,
    promptBlock: renderNoModelFormatBlock(format, []),
    exemplars: [],
    retrievalMode: "rules_only",
  });

  if (!semanticEnabled()) {
    return { ...rulesOnly(), retrievalMode: "disabled" };
  }
  if (explicitlyForbidsSourceDiscovery(input.instruction)) {
    return { ...rulesOnly(), retrievalMode: "opted_out" };
  }

  const postType = input.postType ?? postTypeForFormat(format);
  try {
    const semantic = await buildExemplarBlock({
      topicText: input.instruction,
      workspaceId: input.workspaceId,
      postType,
      includeMediocre: false,
      minSimilarity: LINKEDIN_NATIVE_MIN_SIMILARITY,
      signal: input.signal,
      telemetry: input.telemetry,
      adapterHealth: input.adapterHealth,
    });
    if (semantic.exemplars.length > 0 && semantic.block.trim()) {
      return guidanceFromSemantic(format, semantic);
    }
  } catch (error) {
    if (input.signal?.aborted) throw error;
    console.warn("linkedin_native_semantic_retrieval_skipped", {
      workspaceId: input.workspaceId,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const curated = await loadNoModelFormatExamples(
      format,
      input.workspaceId,
      2,
      input.signal,
    );
    if (curated.length > 0) {
      return guidanceFromCurated(format, curated);
    }
  } catch (error) {
    if (input.signal?.aborted) throw error;
    console.warn("linkedin_native_curated_retrieval_skipped", {
      workspaceId: input.workspaceId,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return rulesOnly();
}
