import { CHAT_MODEL, SUPPORTED_NEWS_MODELS } from "@/lib/openrouter";
import { distinctFallbackModel } from "@/lib/agent/model-routing";

// OpenRouter's "auto" meta-model routes each request to whatever model is most
// popular for the task — so the served model is non-deterministic and can rotate
// through weaker/reasoning-default models between calls. That lottery is fine for
// chat, but the DRAFT WRITER is quality- and reliability-critical: we don't want a
// post's fate decided by which model the router happened to pick. When CHAT_MODEL
// is the auto-router, the writer therefore pins a known-good model instead of
// inheriting CHAT_MODEL. Any explicit OPENROUTER_DIRECT_WRITER_MODEL / _THIN_
// override still wins (a deliberate pin is always honored). Matched on the family
// prefix so both `openrouter/auto` and `openrouter/auto-beta` are covered.
export function isAutoRouterModel(model: string): boolean {
  return model.trim().toLowerCase().startsWith("openrouter/auto");
}

// Luna is the validated native-OpenAI writer.
const PINNED_WRITER_WHEN_AUTO =
  process.env.OPENAI_WRITER_MODEL ||
  process.env.OPENROUTER_WRITER_WHEN_AUTO ||
  "openai/gpt-5.6-luna";

// The writer's effective primary: an explicit writer pin, else a known-good model
// when CHAT_MODEL is the router, else CHAT_MODEL itself (the "one model
// everywhere" default for a normal pinned chat model).
function writerPrimary(envPin: string | undefined): string {
  const explicit = envPin?.trim();
  if (explicit) return explicit;
  return isAutoRouterModel(CHAT_MODEL) ? PINNED_WRITER_WHEN_AUTO : CHAT_MODEL;
}

export const PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL =
  process.env.OPENAI_READ_ONLY_ORCHESTRATOR_MODEL ||
  process.env.OPENROUTER_READ_ONLY_ORCHESTRATOR_MODEL ||
  CHAT_MODEL;
export const FALLBACK_READ_ONLY_ORCHESTRATOR_MODEL = distinctFallbackModel(
  PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL,
  process.env.OPENROUTER_READ_ONLY_ORCHESTRATOR_FALLBACK_MODEL ||
    "google/gemini-3.5-flash",
  ["openai/gpt-5.6-luna"],
);

const SAFE_NEWS_DEFAULT = "openai/gpt-5.6-luna";
export const DEFAULT_NEWS_MODEL = SUPPORTED_NEWS_MODELS.includes(CHAT_MODEL)
  ? CHAT_MODEL
  : SAFE_NEWS_DEFAULT;

export function resolveNewsModel(
  env: { OPENAI_NEWS_MODEL?: string; OPENROUTER_NEWS_MODEL?: string } = {
    OPENAI_NEWS_MODEL: process.env.OPENAI_NEWS_MODEL,
    OPENROUTER_NEWS_MODEL: process.env.OPENROUTER_NEWS_MODEL,
  },
): string {
  const configured =
    env.OPENAI_NEWS_MODEL?.trim() || env.OPENROUTER_NEWS_MODEL?.trim();
  return configured && SUPPORTED_NEWS_MODELS.includes(configured)
    ? configured
    : DEFAULT_NEWS_MODEL;
}

export const PRIMARY_NEWS_MODEL = resolveNewsModel();
const configuredNewsFallback =
  process.env.OPENAI_NEWS_FALLBACK_MODEL?.trim() ||
  process.env.OPENROUTER_NEWS_FALLBACK_MODEL?.trim();
const NEWS_FALLBACK_PREFERRED = SAFE_NEWS_DEFAULT;
export const FALLBACK_NEWS_MODEL = distinctFallbackModel(
  PRIMARY_NEWS_MODEL,
  configuredNewsFallback &&
  SUPPORTED_NEWS_MODELS.includes(configuredNewsFallback)
    ? configuredNewsFallback
    : NEWS_FALLBACK_PREFERRED,
  ["openai/gpt-5.6-luna", "google/gemini-3.1-flash-lite", "z-ai/glm-5.2"].filter(
    (model) => SUPPORTED_NEWS_MODELS.includes(model),
  ),
);

const WRITER_FALLBACK_PREFERRED = "google/gemini-3.5-flash";
const WRITER_FALLBACK_ALTERNATES = [
  "openai/gpt-5.6-luna",
  "google/gemini-3.5-flash",
  "z-ai/glm-5.2",
];

export const PRIMARY_DRAFT_WRITER_MODEL = writerPrimary(
  process.env.OPENAI_DIRECT_WRITER_MODEL ||
    process.env.OPENROUTER_DIRECT_WRITER_MODEL,
);
export const FALLBACK_DRAFT_WRITER_MODEL = distinctFallbackModel(
  PRIMARY_DRAFT_WRITER_MODEL,
  process.env.OPENAI_DIRECT_WRITER_FALLBACK_MODEL ||
    process.env.OPENROUTER_DIRECT_WRITER_FALLBACK_MODEL ||
    WRITER_FALLBACK_PREFERRED,
  WRITER_FALLBACK_ALTERNATES,
);
export const THIN_DRAFT_WRITER_MODEL = writerPrimary(
  process.env.OPENAI_THIN_WRITER_MODEL ||
    process.env.OPENROUTER_THIN_WRITER_MODEL,
);
export const THIN_DRAFT_WRITER_FALLBACK_MODEL = distinctFallbackModel(
  THIN_DRAFT_WRITER_MODEL,
  process.env.OPENAI_THIN_WRITER_FALLBACK_MODEL ||
    process.env.OPENROUTER_THIN_WRITER_FALLBACK_MODEL ||
    WRITER_FALLBACK_PREFERRED,
  WRITER_FALLBACK_ALTERNATES,
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
