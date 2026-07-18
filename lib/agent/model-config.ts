import { CHAT_MODEL, SUPPORTED_NEWS_MODELS } from "@/lib/openrouter";
import { distinctFallbackModel } from "@/lib/agent/model-routing";

export const PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL =
  process.env.OPENROUTER_READ_ONLY_ORCHESTRATOR_MODEL || CHAT_MODEL;
export const FALLBACK_READ_ONLY_ORCHESTRATOR_MODEL = distinctFallbackModel(
  PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL,
  process.env.OPENROUTER_READ_ONLY_ORCHESTRATOR_FALLBACK_MODEL ||
    "google/gemini-3.5-flash",
  ["anthropic/claude-sonnet-5"],
);

const SAFE_NEWS_DEFAULT = "anthropic/claude-haiku-4.5";
export const DEFAULT_NEWS_MODEL = SUPPORTED_NEWS_MODELS.includes(CHAT_MODEL)
  ? CHAT_MODEL
  : SAFE_NEWS_DEFAULT;

export function resolveNewsModel(
  env: { OPENROUTER_NEWS_MODEL?: string } = {
    OPENROUTER_NEWS_MODEL: process.env.OPENROUTER_NEWS_MODEL,
  },
): string {
  const configured = env.OPENROUTER_NEWS_MODEL?.trim();
  return configured && SUPPORTED_NEWS_MODELS.includes(configured)
    ? configured
    : DEFAULT_NEWS_MODEL;
}

export const PRIMARY_NEWS_MODEL = resolveNewsModel();
const configuredNewsFallback =
  process.env.OPENROUTER_NEWS_FALLBACK_MODEL?.trim();
export const FALLBACK_NEWS_MODEL = distinctFallbackModel(
  PRIMARY_NEWS_MODEL,
  configuredNewsFallback &&
  SUPPORTED_NEWS_MODELS.includes(configuredNewsFallback)
    ? configuredNewsFallback
    : SAFE_NEWS_DEFAULT,
  ["openai/gpt-5.6-luna", "google/gemini-3.1-flash-lite", "z-ai/glm-5.2"].filter(
    (model) => SUPPORTED_NEWS_MODELS.includes(model),
  ),
);

export const PRIMARY_DRAFT_WRITER_MODEL =
  process.env.OPENROUTER_DIRECT_WRITER_MODEL || CHAT_MODEL;
export const FALLBACK_DRAFT_WRITER_MODEL = distinctFallbackModel(
  PRIMARY_DRAFT_WRITER_MODEL,
  process.env.OPENROUTER_DIRECT_WRITER_FALLBACK_MODEL ||
    "anthropic/claude-sonnet-5",
  ["google/gemini-3.5-flash"],
);
export const THIN_DRAFT_WRITER_MODEL =
  process.env.OPENROUTER_THIN_WRITER_MODEL || CHAT_MODEL;
export const THIN_DRAFT_WRITER_FALLBACK_MODEL = distinctFallbackModel(
  THIN_DRAFT_WRITER_MODEL,
  process.env.OPENROUTER_THIN_WRITER_FALLBACK_MODEL ||
    "anthropic/claude-sonnet-5",
  ["google/gemini-3.5-flash"],
);

/** Public, non-secret deployment routing for health checks and incident triage. */
export function activeCoworkModelRouting() {
  return {
    planner: {
      // Both planners are server-compiled now — no LLM chooses the action
      // plan. read_only used to run an OpenRouter planner (a flaky primary +
      // a fallback that mangled the tool schema), which dead-ended real
      // requests in "I couldn't compile a safe research plan." The plan is now
      // built deterministically from the route (read-only-orchestrator.ts
      // compileServerReadOnlyPlan), so there is no model to report or fail.
      news: { strategy: "server_compiled" as const, model: null },
      read_only: { strategy: "server_compiled" as const, model: null },
    },
    search: {
      primary: PRIMARY_NEWS_MODEL,
      fallback: FALLBACK_NEWS_MODEL,
    },
    writer: {
      primary: PRIMARY_DRAFT_WRITER_MODEL,
      fallback: FALLBACK_DRAFT_WRITER_MODEL,
      thin_primary: THIN_DRAFT_WRITER_MODEL,
      thin_fallback: THIN_DRAFT_WRITER_FALLBACK_MODEL,
    },
  };
}
