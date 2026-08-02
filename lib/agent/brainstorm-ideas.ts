import { z } from "zod";
import type { GroundedSource } from "@/lib/agent/evidence";
import type { GroundedAnswerAttempt } from "@/lib/agent/grounded-answer";
import type { ToolResult } from "@/lib/agent/tools";
import {
  unsupportedFactualSpecific,
  unsupportedFirstPersonClaim,
} from "@/lib/agent/draft-output-policy";
import { FALLBACK_READ_ONLY_ORCHESTRATOR_MODEL } from "@/lib/agent/model-config";
import { INJECTION_GUARD, wrapUntrustedDelimited } from "@/lib/agent/untrusted";
import {
  CHAT_MODEL,
  completeChat,
  type ToolDef,
  type Usage,
} from "@/lib/openrouter";

const TOOL_NAME = "return_brainstorm_ideas";

const BrainstormIdeaSchema = z
  .object({
    title: z.string().trim().min(3).max(120),
    angle: z.string().trim().min(10).max(320),
    hook_style: z.string().trim().min(2).max(80),
    source_ids: z.array(z.string().trim().min(1)).min(1).max(3),
  })
  .strict();

const BrainstormResultSchema = z
  .object({ ideas: z.array(BrainstormIdeaSchema).length(5) })
  .strict();

export type BrainstormIdeasInput = {
  instruction: string;
  ideaCount: 5;
  evidence: GroundedSource[];
  voiceResult: ToolResult;
  preferences?: readonly unknown[];
  workspaceLearningBlock?: string;
  signal?: AbortSignal;
};

export type BrainstormIdeasResult = {
  content: string;
  model: string;
  usage?: Usage;
  attempts?: GroundedAnswerAttempt[];
};

export type SynthesizeBrainstormIdeas = (
  input: BrainstormIdeasInput,
) => Promise<BrainstormIdeasResult>;

export class BrainstormIdeasSynthesisError extends Error {
  constructor(
    message: string,
    readonly attempts: GroundedAnswerAttempt[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BrainstormIdeasSynthesisError";
  }
}

const BRAINSTORM_TOOL: ToolDef = {
  type: "function",
  function: {
    name: TOOL_NAME,
    description: "Return exactly five distinct, evidence-inspired post ideas.",
    // Keep provider-side structured output and server-side validation on the
    // same schema so cardinality or field constraints cannot drift.
    parameters: z.toJSONSchema(BrainstormResultSchema),
  },
};

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function evidenceBlock(source: GroundedSource, index: number): string {
  const niche = source.card?.authorNiche;
  const metadata = [
    `id=${source.id}`,
    source.author ? `author=${source.author}` : "",
    niche ? `source_niche=${niche}` : "",
    source.metrics?.reactions !== undefined
      ? `reactions=${source.metrics.reactions}`
      : "",
    source.metrics?.comments !== undefined
      ? `comments=${source.metrics.comments}`
      : "",
    source.metrics?.reposts !== undefined
      ? `reposts=${source.metrics.reposts}`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return wrapUntrustedDelimited({
    label: "VIRAL SOURCE SIGNAL",
    endLabel: "END VIRAL SOURCE SIGNAL",
    text: [`source_index=${index + 1} ${metadata}`, source.text].join("\n"),
  });
}

function boundedJson(value: unknown, max = 8_000): string {
  const serialized = JSON.stringify(value ?? null);
  return serialized.length <= max ? serialized : serialized.slice(0, max);
}

function acceptedIdeas(
  raw: unknown,
  evidence: GroundedSource[],
  groundingContext: string,
): z.infer<typeof BrainstormIdeaSchema>[] {
  const parsed = BrainstormResultSchema.parse(raw);
  const sourceIds = new Set(evidence.map((source) => source.id));
  const normalized = parsed.ideas.map((idea) => ({
    ...idea,
    title: oneLine(idea.title),
    angle: oneLine(idea.angle),
    hook_style: oneLine(idea.hook_style),
    source_ids: [...new Set(idea.source_ids)],
  }));
  if (
    normalized.some(
      (idea) =>
        idea.source_ids.length === 0 ||
        idea.source_ids.some((sourceId) => !sourceIds.has(sourceId)),
    )
  ) {
    throw new Error("Brainstorm ideas referenced unknown evidence.");
  }
  const fingerprints = normalized.map((idea) =>
    `${idea.title}\n${idea.angle}`.toLocaleLowerCase("en-US"),
  );
  if (new Set(fingerprints).size !== normalized.length) {
    throw new Error("Brainstorm ideas were not distinct.");
  }
  const referencedSourceIds = new Set(
    normalized.flatMap((idea) => idea.source_ids),
  );
  if (referencedSourceIds.size < Math.min(3, evidence.length)) {
    throw new Error("Brainstorm ideas did not use a diverse source set.");
  }
  const sourceNicheById = new Map(
    evidence.flatMap((source) =>
      source.card?.authorNiche
        ? [[source.id, source.card.authorNiche] as const]
        : [],
    ),
  );
  const availableNiches = new Set(sourceNicheById.values());
  const referencedNiches = new Set(
    [...referencedSourceIds].flatMap((sourceId) => {
      const niche = sourceNicheById.get(sourceId);
      return niche ? [niche] : [];
    }),
  );
  if (referencedNiches.size < Math.min(3, availableNiches.size)) {
    throw new Error(
      "Brainstorm ideas did not span the available source niches.",
    );
  }
  const unsupportedClaim = normalized
    .map((idea) =>
      unsupportedFirstPersonClaim(
        `${idea.title}. ${idea.angle}`,
        groundingContext,
      ),
    )
    .find(Boolean);
  if (unsupportedClaim) {
    throw new Error("Brainstorm ideas introduced an unsupported user claim.");
  }
  const unsupportedSpecificity = normalized
    .map((idea) =>
      unsupportedFactualSpecific(
        `${idea.title}. ${idea.angle}`,
        groundingContext,
      ),
    )
    .find(Boolean);
  if (unsupportedSpecificity) {
    throw new Error("Brainstorm ideas introduced unsupported factual detail.");
  }
  return normalized;
}

function renderIdeas(ideas: z.infer<typeof BrainstormIdeaSchema>[]): string {
  return [
    "Here are 5 post ideas:",
    ...ideas.map(
      (idea, index) =>
        `**${index + 1}. ${idea.title}**\n- *Angle:* ${idea.angle}\n- *Hook style:* ${idea.hook_style}`,
    ),
  ].join("\n\n");
}

export const synthesizeBrainstormIdeas: SynthesizeBrainstormIdeas = async (
  input,
) => {
  if (input.ideaCount !== 5) {
    throw new Error("The brainstorm contract requires exactly five ideas.");
  }
  const models = [
    ...new Set([CHAT_MODEL, FALLBACK_READ_ONLY_ORCHESTRATOR_MODEL]),
  ];
  const attempts: GroundedAnswerAttempt[] = [];
  let lastError: unknown = new Error("Brainstorm synthesis failed.");

  for (const [modelIndex, model] of models.entries()) {
    const startedAt = Date.now();
    let usage: Usage | undefined;
    let attemptedModel = model;
    try {
      const response = await completeChat({
        model,
        reasoningEffort: "high",
        cachePrompt: false,
        maxTokens: 1_800,
        timeoutMs: 30_000,
        signal: input.signal,
        tools: [BRAINSTORM_TOOL],
        forceTool: TOOL_NAME,
        messages: [
          {
            role: "system",
            content: [
              "You are SwipeIn's evidence-grounded post-idea strategist.",
              "Return exactly five distinct ideas through return_brainstorm_ideas. Each idea needs a concise title, a one-line angle, a named hook style, and one to three source ids.",
              "Treat source posts as trend and format signals, not copy. Pull useful patterns across all represented source niches, then adapt every subject and angle to the user's audience, topics, niche, and voice profile.",
              "Do not draft full posts. Do not invent personal experiences, customer results, credentials, metrics, or opinions for the user. Prefer concrete tension, novelty, stakes, and useful specificity over generic advice.",
              "The source cards are internal evidence only. Do not mention creators, source posts, citations, or URLs in the ideas.",
              INJECTION_GUARD,
            ].join("\n\n"),
          },
          {
            role: "user",
            content: [
              `AUTHORITATIVE REQUEST: ${input.instruction}`,
              wrapUntrustedDelimited({
                label: "VOICE PROFILE",
                endLabel: "END VOICE PROFILE",
                text: boundedJson(input.voiceResult),
              }),
              input.preferences?.length
                ? wrapUntrustedDelimited({
                    label: "CONTENT PREFERENCES",
                    endLabel: "END CONTENT PREFERENCES",
                    text: boundedJson(input.preferences, 4_000),
                  })
                : "",
              input.workspaceLearningBlock
                ? wrapUntrustedDelimited({
                    label: "WORKSPACE LEARNING",
                    endLabel: "END WORKSPACE LEARNING",
                    text: input.workspaceLearningBlock.slice(0, 6_000),
                  })
                : "",
              ...input.evidence.map(evidenceBlock),
            ]
              .filter(Boolean)
              .join("\n\n"),
          },
        ],
      });
      usage = response.usage;
      attemptedModel = response.model || model;
      const groundingContext = [
        input.instruction,
        boundedJson(input.voiceResult),
        boundedJson(input.preferences, 4_000),
        input.workspaceLearningBlock ?? "",
      ].join("\n");
      const ideas = acceptedIdeas(
        response.toolArgs,
        input.evidence,
        groundingContext,
      );
      attempts.push({
        model: attemptedModel,
        stage: modelIndex === 0 ? "primary" : "fallback",
        outcome: "accepted",
        latencyMs: Math.max(0, Date.now() - startedAt),
        usage,
      });
      return {
        content: renderIdeas(ideas),
        model: attemptedModel,
        usage,
        attempts,
      };
    } catch (error) {
      if (input.signal?.aborted) throw error;
      attempts.push({
        model: attemptedModel,
        stage: modelIndex === 0 ? "primary" : "fallback",
        outcome: "failed",
        latencyMs: Math.max(0, Date.now() - startedAt),
        ...(usage ? { usage } : {}),
        reasonCode: error instanceof Error ? error.message : String(error),
      });
      lastError = error;
    }
  }

  throw new BrainstormIdeasSynthesisError(
    lastError instanceof Error
      ? lastError.message
      : "Brainstorm synthesis failed.",
    attempts,
    { cause: lastError },
  );
};
