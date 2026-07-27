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

// The known-good writer used as PRIMARY when CHAT_MODEL is the auto-router.
// Sonnet 5 is the reliable, deterministic primary; Luna (the most stable writer
// for this app) is kept as the fallback below. Both are priced in
// OPENROUTER_PRICING, so cost accounting stays exact. Env-overridable for a
// one-line change if a better writer emerges.
const PINNED_WRITER_WHEN_AUTO =
  process.env.OPENROUTER_WRITER_WHEN_AUTO || "anthropic/claude-sonnet-5";

// The writer's effective primary: an explicit writer pin, else a known-good model
// when CHAT_MODEL is the router, else CHAT_MODEL itself (the "one model
// everywhere" default for a normal pinned chat model).
function writerPrimary(envPin: string | undefined): string {
  const explicit = envPin?.trim();
  if (explicit) return explicit;
  return isAutoRouterModel(CHAT_MODEL) ? PINNED_WRITER_WHEN_AUTO : CHAT_MODEL;
}

export const PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL =
  process.env.OPENROUTER_READ_ONLY_ORCHESTRATOR_MODEL || CHAT_MODEL;
export const FALLBACK_READ_ONLY_ORCHESTRATOR_MODEL = distinctFallbackModel(
  PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL,
  process.env.OPENROUTER_READ_ONLY_ORCHESTRATOR_FALLBACK_MODEL ||
    "google/gemini-3.5-flash",
  ["anthropic/claude-sonnet-5"],
);

const SAFE_NEWS_DEFAULT = "anthropic/claude-haiku-4.5";
// Haiku is the news default on BOTH provider paths: via OpenRouter's web
// plugin historically, and under AI_PROVIDER=anthropic via the adapter's
// direct-only web_search server tool (migration allowed pre-gen-5 models to
// call it directly). Live A/B runs showed haiku surfaces the same major
// stories as Sonnet 5 (same search backend) at ~half the cost and ~2-3x the
// speed — and, being much faster, it doesn't brush the 45s stage timeout
// the way a multi-search Sonnet discovery can. Sonnet 5 is the in-provider
// fallback under the flag (below), so a haiku miss retries on the stronger
// model without depending on OpenRouter.
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
// Under the flag the preferred fallback is Sonnet 5 — same provider, full
// programmatic web_search — so a haiku failure retries in-provider. Off the
// flag the historical safe default keeps the cross-provider alternates
// below as the distinct fallback.
const NEWS_FALLBACK_PREFERRED =
  process.env.AI_PROVIDER === "anthropic"
    ? "anthropic/claude-sonnet-5"
    : SAFE_NEWS_DEFAULT;
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

// When the auto-router is active the writer pins a reliable primary (Sonnet 5)
// and keeps Luna — the most stable writer for this app — as the cross-model
// fallback, so neither the first nor the second attempt rides the router lottery.
// With a normal pinned CHAT_MODEL, behavior is unchanged: primary inherits
// CHAT_MODEL, fallback stays Sonnet 5. The alternates list gives
// distinctFallbackModel an escape if a pin ever collides with the preferred
// fallback, so it can never throw "no distinct fallback".
const WRITER_FALLBACK_PREFERRED = isAutoRouterModel(CHAT_MODEL)
  ? "openai/gpt-5.6-luna"
  : "anthropic/claude-sonnet-5";
const WRITER_FALLBACK_ALTERNATES = [
  "anthropic/claude-sonnet-5",
  "openai/gpt-5.6-luna",
  "google/gemini-3.5-flash",
];

export const PRIMARY_DRAFT_WRITER_MODEL = writerPrimary(
  process.env.OPENROUTER_DIRECT_WRITER_MODEL,
);
export const FALLBACK_DRAFT_WRITER_MODEL = distinctFallbackModel(
  PRIMARY_DRAFT_WRITER_MODEL,
  process.env.OPENROUTER_DIRECT_WRITER_FALLBACK_MODEL ||
    WRITER_FALLBACK_PREFERRED,
  WRITER_FALLBACK_ALTERNATES,
);
export const THIN_DRAFT_WRITER_MODEL = writerPrimary(
  process.env.OPENROUTER_THIN_WRITER_MODEL,
);
export const THIN_DRAFT_WRITER_FALLBACK_MODEL = distinctFallbackModel(
  THIN_DRAFT_WRITER_MODEL,
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
