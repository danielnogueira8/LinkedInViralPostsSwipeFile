// Anti-repetition tracker — the UPSTREAM half of the "you keep circling the
// same identity anchors" fix. Where the sameness detector (sameness.ts) is a
// POST-generation rewrite, this runs BEFORE generation: it reads the recent
// drafts, infers which identity anchors are overused, and produces a prompt
// BLOCK that tells the writer to avoid them in the first place.
//
// Why both halves: the rewrite (D) is a safety net that always fires; the
// prompt constraint (B) shapes the FIRST draft so the model doesn't reach for
// the crutch at all — which is cheaper (no rewrite call) and produces a more
// coherent post (rewrites can leave seams). B narrows how often D has to fire.
//
// Design mirrors the other fail-open model helpers (sameness.ts, idea-brief.ts,
// turn/intent-decision.ts):
//   • Model-inferred (no taxonomy) per the user's design pick.
//   • Forced-tool structured output on a strong judgment model (Sonnet 5).
//   • FAIL-OPEN: any error/timeout/empty → return an EMPTY block, so the
//     generation prompt is byte-identical to today. A tracker failure can
//     never break or even change a turn.
//   • Skip under a minimum draft count (no inferrable pattern).
//   • Runs ONCE per turn/batch (not per draft) — it's a turn-level constraint.

import {
  CHAT_MODEL,
  completeChat,
  logOpenRouterUsage,
  UsagePersistenceError,
  type ToolDef,
} from "@/lib/openrouter";
import {
  coworkAdapterHealth,
  type AdapterHealthRegistry,
} from "@/lib/agent/adapter-health";
import {
  runCoworkAdapterAttempt,
  providerModelAttribution,
} from "@/lib/agent/cowork-adapter-attempt";
import type { CoworkTurnTelemetry } from "@/lib/agent/cowork-telemetry";
import { supabaseAdmin } from "@/lib/supabase";
import { createHash } from "node:crypto";
import type { RecentDraft } from "@/lib/recent-drafts";

// Defaults to the one app-wide chat model (OPENROUTER_CHAT_MODEL) so every
// text-LLM call uses the SAME model unless pinned via OPENROUTER_FRESHNESS_MODEL.
export const FRESHNESS_MODEL =
  process.env.OPENROUTER_FRESHNESS_MODEL || CHAT_MODEL;

// ON by default. AGENT_FRESHNESS_TRACKER=0 disables — a one-flag kill switch;
// with it off the generation prompt is unchanged from before this feature.
export function freshnessEnabled(): boolean {
  return process.env.AGENT_FRESHNESS_TRACKER !== "0";
}

// The tracker runs BEFORE generation, so its latency is added to time-to-first
// draft. Cap tightly — a slow tracker call must not stall the turn. 6s matches
// the other pre-generation model-helper budgets.
const FRESHNESS_TIMEOUT_MS = Number(
  process.env.AGENT_FRESHNESS_TIMEOUT_MS || 6000,
);

// Skip under this many prior drafts — below it, "overused" is noise.
export const FRESHNESS_MIN_PRIOR_DRAFTS = 5;

// Cap markers surfaced into the prompt. Too many turns the constraint into a
// straitjacket ("avoid everything about yourself"); 6 keeps it a nudge.
export const FRESHNESS_MAX_MARKERS = 6;

export const FRESHNESS_MAX_PRIOR_IN_PROMPT = 20;
export const FRESHNESS_PROMPT_VERSION = 1;

export type FreshnessConstraint = {
  // The rendered prompt block to inject, or "" when there's nothing to add
  // (disabled, thin history, no overused markers, or fail-open).
  block: string;
  // The overused markers the model inferred. Reported even when block is ""
  // for telemetry parity with the sameness pass.
  markers: string[];
};

const EMPTY: FreshnessConstraint = { block: "", markers: [] };

export function freshnessHistoryHash(priorDrafts: RecentDraft[]): string {
  const exactInput = priorDrafts
    .slice(0, FRESHNESS_MAX_PRIOR_IN_PROMPT)
    .map((draft) => [draft.id, draft.body, draft.createdAt]);
  return createHash("sha256").update(JSON.stringify(exactInput)).digest("hex");
}

async function readFreshnessCache(opts: {
  workspaceId: string;
  historyHash: string;
}): Promise<string[] | null> {
  try {
    const { data, error } = await supabaseAdmin()
      .from("freshness_constraint_cache")
      .select("history_hash, model, prompt_version, markers")
      .eq("workspace_id", opts.workspaceId)
      .maybeSingle();
    if (error || !data) return null;
    if (
      data.history_hash !== opts.historyHash ||
      data.model !== FRESHNESS_MODEL ||
      data.prompt_version !== FRESHNESS_PROMPT_VERSION ||
      !Array.isArray(data.markers)
    ) {
      return null;
    }
    return data.markers.filter((marker): marker is string => typeof marker === "string");
  } catch {
    return null;
  }
}

async function writeFreshnessCache(opts: {
  workspaceId: string;
  historyHash: string;
  markers: string[];
}): Promise<void> {
  try {
    await supabaseAdmin()
      .from("freshness_constraint_cache")
      .upsert(
        {
          workspace_id: opts.workspaceId,
          history_hash: opts.historyHash,
          model: FRESHNESS_MODEL,
          prompt_version: FRESHNESS_PROMPT_VERSION,
          markers: opts.markers,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "workspace_id" },
      );
  } catch {
    // Cache persistence must never block drafting.
  }
}

const FRESHNESS_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "report_overused_anchors",
    description:
      "Report the identity anchors this writer has OVERUSED across their recent drafts, so the next draft can avoid them.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["overused_markers"],
      properties: {
        overused_markers: {
          type: "array",
          description:
            "Identity anchors (biographical facts, personal references, pet phrases, repeated framings) that appear across a MAJORITY of the recent drafts and have become crutches. Short human-readable strings the writer will be told to avoid. Empty when nothing is meaningfully overused.",
          items: { type: "string" },
          maxItems: 8,
        },
      },
    },
  },
};

function buildSystem(): string {
  return [
    "You analyze a writer's recent LinkedIn drafts to find IDENTITY ANCHORS they overuse.",
    "",
    "Identity anchors are: biographical facts (nationality, past careers, hobbies), specific personal references (a named past client, a past game/app they built or played), and pet phrases or framings the writer keeps returning to.",
    "",
    "An anchor is OVERUSED when it appears across a MAJORITY of the recent drafts — it's become a crutch the writer leans on to feel on-brand, regardless of topic.",
    "",
    "Report ONLY the overused anchors. Do NOT report:",
    "  • Anchors that appear once or twice (that's normal variety).",
    "  • The writer's general topic area or expertise (that SHOULD be consistent).",
    "  • Stylistic traits like sentence rhythm or tone (those are voice, not crutches).",
    "",
    "Call report_overused_anchors with the list. Empty list when nothing is genuinely overused.",
  ].join("\n");
}

function buildUser(priorDrafts: RecentDraft[]): string {
  const prior = priorDrafts
    .slice(0, FRESHNESS_MAX_PRIOR_IN_PROMPT)
    .map((d, i) => `[Draft ${i + 1}]\n${d.body}`)
    .join("\n\n---\n\n");
  return ["RECENT DRAFTS (most recent first):", "", prior].join("\n");
}

// Render the prompt block from the overused markers. Empty markers → empty
// block (nothing to inject). Pure + exported so the exact injected text is
// unit-testable and so callers can render without a model call in tests.
export function renderFreshnessBlock(markers: string[]): string {
  const clean = markers
    .filter((m) => typeof m === "string" && m.trim())
    .slice(0, FRESHNESS_MAX_MARKERS)
    .map((m) => m.trim());
  if (clean.length === 0) return "";
  return [
    "FRESHNESS — AVOID SELF-REPETITION:",
    "Across your recent posts you've leaned repeatedly on these identity anchors:",
    ...clean.map((m) => `  • ${m}`),
    "Do NOT use any of them in this post UNLESS the topic genuinely demands it (e.g. the post is explicitly about that experience). Reach for a different angle, a different proof point, a different way in. Your voice is your rhythm and point of view — not a checklist of the same personal facts every time.",
  ].join("\n");
}

// Parse the tool args defensively.
export function parseFreshnessArgs(args: unknown): string[] {
  const obj = (args && typeof args === "object" ? args : {}) as Record<
    string,
    unknown
  >;
  return Array.isArray(obj.overused_markers)
    ? obj.overused_markers.filter((s): s is string => typeof s === "string")
    : [];
}

// The public entry point. Reads prior drafts, infers overused anchors, and
// returns a prompt block to inject. Provider/content failures fail open to an
// empty block; authoritative usage-ledger failures propagate.
export async function computeFreshnessConstraint(opts: {
  priorDrafts: RecentDraft[];
  workspaceId?: string;
  signal?: AbortSignal;
  telemetry?: CoworkTurnTelemetry;
  adapterHealth?: AdapterHealthRegistry;
}): Promise<FreshnessConstraint> {
  if (!freshnessEnabled()) return EMPTY;
  if (opts.priorDrafts.length < FRESHNESS_MIN_PRIOR_DRAFTS) return EMPTY;

  const historyHash = freshnessHistoryHash(opts.priorDrafts);
  if (opts.workspaceId) {
    const cached = await readFreshnessCache({
      workspaceId: opts.workspaceId,
      historyHash,
    });
    if (cached !== null) {
      return { markers: cached, block: renderFreshnessBlock(cached) };
    }
  }

  try {
    const attempt = await runCoworkAdapterAttempt({
      registry: opts.adapterHealth ?? coworkAdapterHealth,
      adapterKey: `cowork_legacy_freshness:${FRESHNESS_MODEL}`,
      signal: opts.signal,
      call: () =>
        completeChat({
          model: FRESHNESS_MODEL,
          maxTokens: 300,
          timeoutMs: FRESHNESS_TIMEOUT_MS,
          tools: [FRESHNESS_TOOL],
          forceTool: "report_overused_anchors",
          messages: [
            { role: "system", content: buildSystem() },
            { role: "user", content: buildUser(opts.priorDrafts) },
          ],
          signal: opts.signal,
        }),
      validate: (response) => {
        const values = response.toolArgs?.overused_markers;
        if (
          !Array.isArray(values) ||
          values.some((value) => typeof value !== "string")
        ) {
          throw new Error("Freshness response was missing its required schema.");
        }
        return parseFreshnessArgs(response.toolArgs);
      },
      persistUsage: (response) => {
        if (!opts.workspaceId) return Promise.resolve();
        const attribution = providerModelAttribution(FRESHNESS_MODEL, response.model);
        return logOpenRouterUsage(
          "freshness",
          attribution.model,
          response.usage,
          opts.workspaceId,
          attribution.metadata,
        );
      },
      usage: (response) => response.usage,
      responseModel: (response) => response.model,
      telemetry: opts.telemetry,
      stage: "legacy_freshness_prepass",
      attempt: 1,
      model: FRESHNESS_MODEL,
      rejectedReasonCode: "invalid_freshness_response",
    });
    const markers = attempt.value;
    const block = renderFreshnessBlock(markers);
    if (opts.workspaceId) {
      await writeFreshnessCache({
        workspaceId: opts.workspaceId,
        historyHash,
        markers,
      });
    }
    if (block && opts.workspaceId) {
      console.log(
        JSON.stringify({
          freshness_markers: {
            markers: markers.slice(0, FRESHNESS_MAX_MARKERS),
            workspace_id: opts.workspaceId,
          },
        }),
      );
    }
    return { block, markers };
  } catch (error) {
    if (
      error instanceof UsagePersistenceError ||
      (error instanceof Error && error.name === "UsagePersistenceError")
    ) {
      throw error;
    }
    return EMPTY;
  }
}
