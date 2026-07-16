// Sameness detector — the "you keep leaning on the same 5 identity anchors"
// pass. Runs AFTER a draft body is finalized and BEFORE it ships as a card.
//
// The problem it solves: even with a rich voice profile, GLM (and to a lesser
// extent Sonnet) treats biographical facts and pet phrases as "passwords" that
// prove it's on-brand. So every draft mentions the same anchors — for Daniel,
// that's "I was a League of Legends player", "I'm from Portugal", "hooks are
// the gate", "40 clients", etc. The user's complaint: it feels like the model
// is always circling the same handful of angles even when the topic doesn't
// call for them.
//
// This module reads the JUST-WRITTEN body + the last N drafts (model-inferred
// approach per user's design pick) and asks a stronger judgment model: "which
// identity anchors does this new draft share with a majority of the prior
// drafts? If ≥2, rewrite the new draft removing the overlapping anchors."
//
// Failure modes designed for:
//   • Fail-open on ANY error (transport, timeout, malformed output, refusal).
//     The un-rewritten body ships, exactly as it would today.
//   • Skip on thin history (< 3 prior drafts) — no repetition pattern is
//     inferrable and the check would only add cost + latency.
//   • Guard the rewrite output: non-empty, not drastically shorter (≥60% of
//     input), not corrupted. Anything else → keep the input body.
//   • Bounded prompt: prior drafts are already truncated by
//     lib/recent-drafts.truncateForPrompt; here we cap the count too.

import {
  CHAT_MODEL,
  completeChat,
  logOpenRouterUsage,
  UsagePersistenceError,
  type ContentBlock,
  type ToolDef,
} from "@/lib/openrouter";
import {
  coworkAdapterHealth,
  type AdapterHealthRegistry,
} from "@/lib/agent/adapter-health";
import { runCoworkAdapterAttempt } from "@/lib/agent/cowork-adapter-attempt";
import type { CoworkTurnTelemetry } from "@/lib/agent/cowork-telemetry";
import { looksCorruptedDraft } from "./nets";
import { editDraftBodySync } from "./editor";
import type { RecentDraft } from "@/lib/recent-drafts";

// Defaults to the one app-wide chat model (OPENROUTER_CHAT_MODEL) so every
// text-LLM call uses the SAME model unless pinned via OPENROUTER_SAMENESS_MODEL.
export const SAMENESS_MODEL =
  process.env.OPENROUTER_SAMENESS_MODEL || CHAT_MODEL;

// Feature flag. ON by default (per the user's request that every draft go
// through this pass). Set AGENT_SAMENESS_CHECK=0 to disable — a one-flag
// kill-switch if the pass ever causes a regression, without a code change.
export function samenessEnabled(): boolean {
  return process.env.AGENT_SAMENESS_CHECK !== "0";
}

// Hard timeout on the sameness call. Runs AFTER the writer finished, so it
// adds directly to perceived draft latency — cap it tightly. 8s is generous
// for a Sonnet call over ~4-5K tokens of context; a slower call → fail open.
const SAMENESS_TIMEOUT_MS = Number(
  process.env.AGENT_SAMENESS_TIMEOUT_MS || 8000,
);

// Skip the check when there are fewer than this many prior drafts. Below 3,
// the "repetition pattern" the model would infer is noise, and the pass just
// adds cost for no signal.
export const SAMENESS_MIN_PRIOR_DRAFTS = 3;

// Cap the prior-draft count in the prompt. Combined with the per-body
// truncation in lib/recent-drafts, this bounds the sameness call at roughly
// 4-5K prompt tokens (20 × 400 chars ≈ 2K tokens of drafts + system + new
// draft + tool schema).
export const SAMENESS_MAX_PRIOR_IN_PROMPT = 20;

export type SamenessResult = {
  // The body to ship. Equal to the input body when we kept it (no overlap, or
  // fail-open), or the rewritten body when the check surfaced overlap and
  // produced a valid rewrite.
  body: string;
  // Did we actually swap in a rewrite?
  rewrote: boolean;
  // Identity anchors the model flagged as overused vs. the prior drafts.
  // Reported even when we don't rewrite (e.g. only 1 overlap, threshold not
  // met) — useful telemetry for the anti-repetition tracker (PR B) which
  // will consume this signal upstream.
  overlapMarkers: string[];
  // A short reason string when we DID rewrite; empty otherwise. Never
  // user-facing (goes to logs only) so it can be model prose.
  reason: string;
};

// The tool the model fills to give us structured output. The model returns
// EITHER `rewrote:false` with a list of markers it observed (may still be
// zero), OR `rewrote:true` with the new body it wrote. Rewriting when there's
// nothing to fix is prevented by the prompt + the ≥2 overlap threshold check
// we apply on our side after parsing.
const SAMENESS_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "report_sameness",
    description:
      "Report identity-marker overlap between the NEW draft and the PRIOR drafts, and rewrite if overlap warrants it.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["overlap_markers", "rewrote", "rewritten_body", "reason"],
      properties: {
        overlap_markers: {
          type: "array",
          description:
            "Identity anchors (biographical facts, pet phrases, repeated framings, personal references) the NEW draft shares with a MAJORITY of the prior drafts. Short human-readable strings. Empty when no meaningful overlap.",
          items: { type: "string" },
          maxItems: 8,
        },
        rewrote: {
          type: "boolean",
          description:
            "True ONLY if you rewrote the draft to remove overlapping identity anchors. False when the draft is fine as-is OR when the topic genuinely requires the overlap.",
        },
        rewritten_body: {
          type: "string",
          description:
            "The full rewritten post body when rewrote=true. Empty string when rewrote=false. Preserve voice, rhythm, and length; the ONLY change is removing overused identity anchors and re-writing those beats from a fresh angle.",
        },
        reason: {
          type: "string",
          description:
            "One-sentence explanation of why you did or didn't rewrite. For logs only.",
          maxLength: 240,
        },
      },
    },
  },
};

function buildSystem(): string {
  return [
    "You are an editorial pass whose ONLY job is to catch and rewrite identity-anchor overuse in a NEW LinkedIn draft.",
    "",
    "You receive:",
    "  1. The NEW draft the writer just produced.",
    "  2. The LAST N drafts this same person has written (truncated).",
    "",
    "Your job:",
    "  • Identify identity anchors the NEW draft leans on: biographical facts (nationality, past careers, hobbies), personal references (specific past clients, past games/apps), pet phrases the writer keeps returning to (\"hooks are the gate\", \"specific beats clever\").",
    "  • Determine which of those anchors ALSO appear in a MAJORITY of the prior drafts. Those are OVERUSED.",
    "  • If ≥2 anchors are overused, REWRITE the draft removing them. Preserve voice, rhythm, structure, and approximate length. Rewrite the beats that USED those anchors from a fresh angle — do NOT just delete them and shorten the post.",
    "  • If <2 anchors are overused, or if the topic genuinely requires the anchor (e.g. a post explicitly about the writer's past as a League of Legends player), keep the draft as-is. Set rewrote=false.",
    "",
    "Rewriting rules (when rewrote=true):",
    "  • Same POV, same tone, same rhythm. Bloody hands off the voice.",
    "  • Same rough length (±20%). Never drop below 60% of the input length.",
    "  • No em-dashes, no rule-of-three cadences, no code-fence markers.",
    "  • The rewritten body is a plain-text LinkedIn post — no JSON, no XML, no tool-call syntax.",
    "",
    "Call report_sameness with your verdict. Never reply outside the tool.",
  ].join("\n");
}

export function buildSamenessUserContent(
  newBody: string,
  priorDrafts: RecentDraft[],
): ContentBlock[] {
  const prior = priorDrafts
    .slice(0, SAMENESS_MAX_PRIOR_IN_PROMPT)
    .map((d, i) => `[Prior draft ${i + 1}]\n${d.body}`)
    .join("\n\n---\n\n");
  return [
    {
      type: "text",
      text: [
        "PRIOR DRAFTS (most recent first):",
        "",
        prior || "(none)",
        "",
        "---",
      ].join("\n"),
      // A weekly batch checks seven new drafts against this exact same history.
      // Keep that large prefix byte-identical and cacheable; the per-draft body
      // remains in the uncached suffix below.
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: ["", "", "NEW DRAFT to check:", "", newBody].join("\n"),
    },
  ];
}

// Parse the tool_args JSON the model returned. Defensive: any missing or
// wrong-typed field falls back to a safe default (no rewrite, no markers).
export function parseSamenessArgs(args: unknown): {
  overlapMarkers: string[];
  rewrote: boolean;
  rewrittenBody: string;
  reason: string;
} {
  const obj = (args && typeof args === "object" ? args : {}) as Record<
    string,
    unknown
  >;
  const overlapMarkers = Array.isArray(obj.overlap_markers)
    ? obj.overlap_markers.filter((s): s is string => typeof s === "string")
    : [];
  const rewrote = obj.rewrote === true;
  const rewrittenBody =
    typeof obj.rewritten_body === "string" ? obj.rewritten_body : "";
  const reason = typeof obj.reason === "string" ? obj.reason : "";
  return { overlapMarkers, rewrote, rewrittenBody, reason };
}

// Guard the rewritten body before we swap it in. Pure so tests can exercise
// every rejection path without touching the model.
export function isAcceptableRewrite(
  input: string,
  rewritten: string,
): { ok: true } | { ok: false; reason: string } {
  const clean = rewritten.trim();
  if (!clean) return { ok: false, reason: "empty" };
  // Never accept a rewrite that dropped a large fraction of the content.
  // 60% floor mirrors the AI-Tell editor's rewrite guard.
  if (clean.length < Math.floor(input.trim().length * 0.6)) {
    return { ok: false, reason: "too_short" };
  }
  // Reuse the corruption detector — a rewrite must not leak tool-call XML,
  // fence markers, or JSON key fragments.
  const corruption = looksCorruptedDraft(clean);
  if (corruption) return { ok: false, reason: `corrupted:${corruption}` };
  return { ok: true };
}

// The public entry point. Reads a body + prior drafts and returns either the
// original body (kept) or a rewritten body (swapped). NEVER throws.
export async function checkSameness(opts: {
  body: string;
  priorDrafts: RecentDraft[];
  workspaceId?: string;
  signal?: AbortSignal;
  adapterHealth?: AdapterHealthRegistry;
  telemetry?: CoworkTurnTelemetry;
}): Promise<SamenessResult> {
  const pass: SamenessResult = {
    body: opts.body,
    rewrote: false,
    overlapMarkers: [],
    reason: "",
  };
  if (!samenessEnabled()) return pass;
  if (opts.priorDrafts.length < SAMENESS_MIN_PRIOR_DRAFTS) return pass;
  if (!opts.body.trim()) return pass;

  const ctrl = new AbortController();
  const onParentAbort = () => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setTimeout(
    () => ctrl.abort(new DOMException("Sameness deadline exceeded", "TimeoutError")),
    SAMENESS_TIMEOUT_MS,
  );

  try {
    const result = await runCoworkAdapterAttempt({
      registry: opts.adapterHealth ?? coworkAdapterHealth,
      adapterKey: `cowork_finalizer_sameness:${SAMENESS_MODEL}`,
      signal: opts.signal,
      call: () =>
        completeChat({
          model: SAMENESS_MODEL,
          // Enough for one rewritten LinkedIn post + the tool envelope. A
          // LinkedIn post is ~800-1500 chars; 2000 tokens leaves ample room.
          maxTokens: 2000,
          tools: [SAMENESS_TOOL],
          forceTool: "report_sameness",
          messages: [
            { role: "system", content: buildSystem() },
            {
              role: "user",
              content: buildSamenessUserContent(opts.body, opts.priorDrafts),
            },
          ],
          signal: ctrl.signal,
        }),
      validate: (res) => {
        const raw = res.toolArgs as Record<string, unknown> | null;
        if (
          !raw ||
          typeof raw.rewrote !== "boolean" ||
          !Array.isArray(raw.overlap_markers) ||
          typeof raw.rewritten_body !== "string" ||
          typeof raw.reason !== "string"
        ) {
          throw new Error("Invalid sameness verdict schema.");
        }
        const parsed = parseSamenessArgs(raw);
        if (
          parsed.rewrote &&
          parsed.rewrittenBody &&
          parsed.overlapMarkers.length >= 2
        ) {
          const guard = isAcceptableRewrite(opts.body, parsed.rewrittenBody);
          if (!guard.ok) {
            throw new Error(`Rejected sameness rewrite: ${guard.reason}`);
          }
          return {
            body: editDraftBodySync(parsed.rewrittenBody, "post").body,
            rewrote: true,
            overlapMarkers: parsed.overlapMarkers,
            reason: parsed.reason,
          };
        }
        return {
          body: opts.body,
          rewrote: false,
          overlapMarkers: parsed.overlapMarkers,
          reason: parsed.reason,
        };
      },
      persistUsage: async (res) => {
        if (opts.workspaceId) {
          await logOpenRouterUsage(
            "sameness",
            SAMENESS_MODEL,
            res.usage,
            opts.workspaceId,
          );
        }
      },
      usage: (res) => res.usage,
      telemetry: opts.telemetry,
      stage: "finalizer_sameness",
      attempt: 1,
      model: SAMENESS_MODEL,
      rejectedReasonCode: "invalid_sameness_verdict",
    });
    return result.value;
  } catch (error) {
    if (
      error instanceof UsagePersistenceError ||
      (error instanceof Error && error.name === "UsagePersistenceError")
    ) {
      throw error;
    }
    // Fail open. Any transport/timeout/parse error → keep the original body.
    return pass;
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener("abort", onParentAbort);
  }
}
