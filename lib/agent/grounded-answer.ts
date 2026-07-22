import {
  CHAT_MODEL,
  completeChat,
  type Usage,
} from "@/lib/openrouter";
import { FALLBACK_READ_ONLY_ORCHESTRATOR_MODEL } from "@/lib/agent/model-config";
import { wrapUntrustedDelimited, INJECTION_GUARD } from "@/lib/agent/untrusted";
import type { GroundedSource } from "@/lib/agent/evidence";

export type GroundedAnswerFormat =
  | "summary"
  | "takeaways"
  | "comparison"
  | "report";

export type GroundedAnswerInput = {
  instruction: string;
  format: GroundedAnswerFormat;
  evidence: GroundedSource[];
  sourcePresentation?: "structured_workspace";
  signal?: AbortSignal;
};

export type GroundedAnswerResult = {
  content: string;
  model: string;
  usage?: Usage;
  attempts?: GroundedAnswerAttempt[];
};

export type GroundedAnswerAttempt = {
  model: string;
  stage: "primary" | "fallback";
  outcome: "accepted" | "failed";
  latencyMs: number;
  usage?: Usage;
  reasonCode?: string;
};

export class GroundedAnswerSynthesisError extends Error {
  constructor(
    message: string,
    readonly attempts: GroundedAnswerAttempt[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GroundedAnswerSynthesisError";
  }
}

export type SynthesizeGroundedAnswer = (
  input: GroundedAnswerInput,
) => Promise<GroundedAnswerResult>;

function evidenceBlock(source: GroundedSource, index: number): string {
  const metadata = [
    `id=${source.id}`,
    `kind=${source.kind}`,
    source.title ? `title=${source.title}` : "",
    source.url ? `url=${source.url}` : "",
    source.publishedAt ? `published_at=${source.publishedAt}` : "",
    source.author ? `author=${source.author}` : "",
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
    label: "VERIFIED EVIDENCE",
    endLabel: "END VERIFIED EVIDENCE",
    text: [`source_index=${index + 1} ${metadata}`, source.text].join("\n"),
  });
}

function acceptedContent(value: string): string | null {
  const content = value.trim();
  if (!content || content.length > 12_000) return null;
  if (/---\s*(?:END\s+)?VERIFIED EVIDENCE/i.test(content)) return null;
  return content;
}

function verifiedSourceReferences(evidence: GroundedSource[]): Array<{
  marker: string;
  line: string;
}> {
  const seen = new Set<string>();
  return evidence.flatMap((source, index) => {
    // Labels are server-owned. Source titles/authors/ids are untrusted data and
    // must never become Markdown syntax in this deterministic footer.
    const label = `Source ${index + 1}`;
    if (!source.url) {
      const marker = `id:${source.kind}:${source.id}`;
      if (seen.has(marker)) return [];
      seen.add(marker);
      return [{ marker, line: `- ${label} (verified ${source.kind})` }];
    }
    try {
      const url = new URL(source.url);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("Unsupported source URL protocol.");
      }
      const normalized = url.toString();
      if (seen.has(normalized)) return [];
      seen.add(normalized);
      return [{ marker: normalized, line: `- [${label}](${normalized})` }];
    } catch {
      const marker = `id:${source.kind}:${source.id}`;
      if (seen.has(marker)) return [];
      seen.add(marker);
      return [{ marker, line: `- ${label} (verified ${source.kind})` }];
    }
  });
}

function withVerifiedSources(
  content: string,
  evidence: GroundedSource[],
): string {
  const missingReferences = verifiedSourceReferences(evidence).filter(
    ({ marker }) => !content.includes(marker),
  );
  if (missingReferences.length === 0) return content;
  return [
    content,
    "",
    "Sources:",
    ...missingReferences.map(({ line }) => line),
  ].join("\n");
}

function flattenMarkdownLinks(content: string): string {
  return content.replace(
    /\[([^\]\n]+)\]\((?:https?:\/\/)[^)\s]+(?:\s+"[^"]*")?\)/gi,
    "$1",
  );
}

export const synthesizeGroundedAnswer: SynthesizeGroundedAnswer = async (
  input,
) => {
  const models = [...new Set([CHAT_MODEL, FALLBACK_READ_ONLY_ORCHESTRATOR_MODEL])];
  let lastError: unknown = new Error("Grounded answer synthesis failed.");
  const attempts: GroundedAnswerAttempt[] = [];
  for (const [modelIndex, model] of models.entries()) {
    const startedAt = Date.now();
    let usage: Usage | undefined;
    let attemptedModel = model;
    try {
      const response = await completeChat({
        model,
        maxTokens: 1_400,
        timeoutMs: 30_000,
        signal: input.signal,
        messages: [
          {
            role: "system",
            content: [
              "You are SwipeIn's grounded research-answer synthesizer.",
              "Return the requested analysis as ordinary assistant text. Never draft, rewrite, or edit a LinkedIn post, and never claim that an artifact was created.",
              "Use only the supplied verified evidence. If the evidence does not support a claim, omit it. Distinguish direct observations from inference.",
              input.sourcePresentation === "structured_workspace"
                ? "The verified source links are attached separately by the server. Do not include a source list, Markdown link, or URL in your answer."
                : "When a source URL is supplied, include a concise Markdown source link. Never invent a URL, metric, author, date, or performance claim.",
              `Requested answer format: ${input.format}.`,
              INJECTION_GUARD,
            ].join("\n\n"),
          },
          {
            role: "user",
            content: [
              `AUTHORITATIVE REQUEST: ${input.instruction}`,
              ...input.evidence.map(evidenceBlock),
            ].join("\n"),
          },
        ],
      });
      usage = response.usage;
      attemptedModel = response.model || model;
      const content = acceptedContent(response.text);
      if (!content) throw new Error("Grounded answer response was invalid.");
      attempts.push({
        model: attemptedModel,
        stage: modelIndex === 0 ? "primary" : "fallback",
        outcome: "accepted",
        latencyMs: Math.max(0, Date.now() - startedAt),
        usage,
      });
      const presentedContent =
        input.sourcePresentation === "structured_workspace"
          ? flattenMarkdownLinks(content)
          : withVerifiedSources(content, input.evidence);
      return {
        content: presentedContent,
        model: response.model || model,
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
  throw new GroundedAnswerSynthesisError(
    lastError instanceof Error
      ? lastError.message
      : "Grounded answer synthesis failed.",
    attempts,
    { cause: lastError },
  );
};
