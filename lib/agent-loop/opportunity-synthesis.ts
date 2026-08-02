import {
  BACKGROUND_MODEL,
  completeChat,
  logOpenRouterUsage,
  type ChatMessage,
  type ToolDef,
} from "@/lib/openrouter";

type OpportunitySynthesisInput<Candidate> = {
  workspaceId: string;
  topics: readonly string[];
  candidates: readonly Candidate[];
  feedback?: readonly string[];
};

export type OpportunitySynthesisResult<Opportunity> = {
  available: boolean;
  opportunities: Map<string, Opportunity>;
};

type OpportunitySynthesisAdapter<Input, Opportunity> = {
  tool: ToolDef;
  usageKind: string;
  failureTag: string;
  messages: (input: Input) => ChatMessage[];
  refine: (input: Input, rows: unknown) => Map<string, Opportunity>;
};

/**
 * Owns the shared paid-model lifecycle for opportunity judgment. Lane adapters
 * retain their evidence, prompts, validation, and ranking; this module keeps
 * empty runs free and makes every model or refinement failure retryable.
 */
export function createOpportunitySynthesizer<
  Candidate,
  Opportunity,
  Input extends OpportunitySynthesisInput<Candidate>,
>(adapter: OpportunitySynthesisAdapter<Input, Opportunity>) {
  return async (
    input: Input,
  ): Promise<OpportunitySynthesisResult<Opportunity>> => {
    if (input.candidates.length === 0) {
      return { available: true, opportunities: new Map() };
    }

    try {
      const response = await completeChat({
        model: BACKGROUND_MODEL,
        reasoningEffort: "high",
        cachePrompt: false,
        maxTokens: 2200,
        timeoutMs: 45_000,
        tools: [adapter.tool],
        forceTool: adapter.tool.function.name,
        messages: adapter.messages(input),
      });
      await logOpenRouterUsage(
        adapter.usageKind,
        response.model,
        response.usage,
        input.workspaceId,
      );
      return {
        available: true,
        opportunities: adapter.refine(input, response.toolArgs?.opportunities),
      };
    } catch (error) {
      console.error(adapter.failureTag, {
        workspaceId: input.workspaceId,
        message: error instanceof Error ? error.message : String(error),
      });
      return { available: false, opportunities: new Map() };
    }
  };
}
