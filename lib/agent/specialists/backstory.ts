// Backstory extractor — the ROOT half of the "you keep circling the same
// identity anchors" fix (A of the A/B/D plan).
//
// The root cause: the voice profile bundles biographical facts (nationality,
// past careers, named clients, hobbies) into the SAME always-on block as the
// style/tone/format rules. So when the writer reads "match this voice", the
// safest completion is to recite those facts — they read as proof-of-voice.
// The user gets a post that name-drops "I was a League of Legends player" and
// "I'm from Portugal" whether or not the topic calls for it.
//
// This module extracts the biographical facts OUT of the profile into a
// separate list. Downstream (buildDraftSystem / buildMessages) then presents
// them as a RETRIEVAL LAYER — "use ONLY when the topic calls for it, do not
// name-drop unprompted" — instead of always-on identity context. The style
// rules stay always-on; the facts become opt-in.
//
// Lazy + cached: the first generation after this ships extracts the facts from
// the existing profile (one Sonnet call) and persists them onto the profile
// JSON, so it's a one-time cost per profile. Re-runs only when the profile is
// re-synthesized (which clears biographical_facts).
//
// FAIL-OPEN throughout: any error → return the profile unchanged (no
// biographical_facts), and the caller falls back to today's behavior (facts
// stay embedded in summary/positioning/exemplars, always-on). A backstory
// failure can never break generation.

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
import { resolveNativeOpenAIPrimary } from "@/lib/model-provider-routing";
import { supabaseAdmin } from "@/lib/supabase";
import type { VoiceProfile } from "@/lib/claude";

// Defaults to the one app-wide chat model (OPENROUTER_CHAT_MODEL) so every
// text-LLM call uses the SAME model unless this task is pinned via
// OPENROUTER_BACKSTORY_MODEL. See lib/openrouter.ts CHAT_MODEL.
export const BACKSTORY_MODEL = resolveNativeOpenAIPrimary(
  [process.env.OPENAI_BACKSTORY_MODEL, process.env.OPENROUTER_BACKSTORY_MODEL],
  CHAT_MODEL,
);

// ON by default. AGENT_BACKSTORY_EXTRACT=0 disables — the profile keeps facts
// embedded (today's behavior), no extraction call, no separate retrieval block.
export function backstoryEnabled(): boolean {
  return process.env.AGENT_BACKSTORY_EXTRACT !== "0";
}

const BACKSTORY_TIMEOUT_MS = Number(
  process.env.AGENT_BACKSTORY_TIMEOUT_MS || 6000,
);

// Cap facts so the retrieval block stays scannable. 12 is generous — most
// people have a handful of recurring anchors.
export const MAX_BIOGRAPHICAL_FACTS = 12;

const BACKSTORY_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "report_biographical_facts",
    description:
      "Report the specific biographical facts / personal anchors this creator references in their content.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["facts"],
      properties: {
        facts: {
          type: "array",
          description:
            "Specific personal facts the creator references: past careers/roles, nationality/location, named past clients or companies, hobbies, notable personal history. Each a short self-contained statement (e.g. 'Former competitive League of Legends player', 'Based in Portugal', 'Ran a content agency for 6 years'). Do NOT include general topic expertise, opinions, or writing-style traits — only concrete biographical anchors. Empty when the profile has none.",
          items: { type: "string" },
          maxItems: 12,
        },
      },
    },
  },
};

function buildSystem(): string {
  return [
    "You extract BIOGRAPHICAL FACTS from a LinkedIn creator's voice profile.",
    "",
    "A biographical fact is a concrete personal anchor: a past career or role, nationality or location, a named past client/company, a hobby, a notable piece of personal history. These are the specific facts a creator tends to reference to establish credibility.",
    "",
    "Do NOT extract:",
    "  • Topic expertise or subject areas (e.g. 'writes about LinkedIn growth') — that's what they cover, not a personal anchor.",
    "  • Opinions, beliefs, or takes (e.g. 'thinks hooks matter most').",
    "  • Writing-style traits (e.g. 'blunt tone', 'uses short sentences').",
    "  • Their audience or who they serve.",
    "",
    "Return ONLY concrete biographical facts. Each should be a short, self-contained statement someone could verify. Empty list when the profile carries no real biographical anchors.",
    "",
    "Call report_biographical_facts with the list. Never reply outside the tool.",
  ].join("\n");
}

// Build the extraction input from the profile fields most likely to carry
// biographical facts. We deliberately include exemplars (the verbatim posts —
// where "I was a LoL player" actually lives) alongside the synthesized fields.
function buildUser(profile: VoiceProfile): string {
  const parts: string[] = [];
  if (profile.summary) parts.push(`SUMMARY:\n${profile.summary}`);
  if (profile.positioning) parts.push(`POSITIONING:\n${profile.positioning}`);
  if (profile.signature_moves?.length) {
    parts.push(`SIGNATURE MOVES:\n${profile.signature_moves.join("\n")}`);
  }
  if (profile.topics?.length) {
    parts.push(`TOPICS:\n${profile.topics.join(", ")}`);
  }
  if (profile.exemplars?.length) {
    parts.push(
      `EXEMPLAR POSTS (verbatim):\n${profile.exemplars
        .map((e, i) => `[Post ${i + 1}]\n${e}`)
        .join("\n\n")}`,
    );
  }
  return parts.join("\n\n---\n\n");
}

export function parseBackstoryArgs(args: unknown): string[] {
  const obj = (args && typeof args === "object" ? args : {}) as Record<
    string,
    unknown
  >;
  return Array.isArray(obj.facts)
    ? obj.facts
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, MAX_BIOGRAPHICAL_FACTS)
    : [];
}

type BackstoryExtractionResult =
  | { status: "accepted"; facts: string[] }
  | { status: "failed" };

type BackstoryExtractionOptions = {
  profile: VoiceProfile;
  workspaceId?: string;
  signal?: AbortSignal;
  telemetry?: CoworkTurnTelemetry;
  adapterHealth?: AdapterHealthRegistry;
};

// Preserve the distinction between an accepted empty result and a transient
// adapter failure. Only the former is safe to cache as "no facts".
async function runBackstoryExtraction(
  opts: BackstoryExtractionOptions,
): Promise<BackstoryExtractionResult> {
  if (!backstoryEnabled()) return { status: "accepted", facts: [] };
  const user = buildUser(opts.profile);
  if (!user.trim()) return { status: "accepted", facts: [] };

  try {
    const attempt = await runCoworkAdapterAttempt({
      registry: opts.adapterHealth ?? coworkAdapterHealth,
      adapterKey: `cowork_legacy_backstory:${BACKSTORY_MODEL}`,
      signal: opts.signal,
      call: () =>
        completeChat({
          // No prompt caching: measured 0 reads across the window.
          cachePrompt: false,
          model: BACKSTORY_MODEL,
          maxTokens: 400,
          timeoutMs: BACKSTORY_TIMEOUT_MS,
          tools: [BACKSTORY_TOOL],
          forceTool: "report_biographical_facts",
          messages: [
            { role: "system", content: buildSystem() },
            { role: "user", content: user },
          ],
          signal: opts.signal,
        }),
      validate: (response) => {
        const facts = response.toolArgs?.facts;
        if (
          !Array.isArray(facts) ||
          facts.some((fact) => typeof fact !== "string")
        ) {
          throw new Error("Backstory response was missing its required schema.");
        }
        return parseBackstoryArgs(response.toolArgs);
      },
      persistUsage: (response) => {
        if (!opts.workspaceId) return Promise.resolve();
        const attribution = providerModelAttribution(BACKSTORY_MODEL, response.model);
        return logOpenRouterUsage(
          "backstory",
          attribution.model,
          response.usage,
          opts.workspaceId,
          attribution.metadata,
        );
      },
      usage: (response) => response.usage,
      responseModel: (response) => response.model,
      telemetry: opts.telemetry,
      stage: "legacy_backstory_prepass",
      attempt: 1,
      model: BACKSTORY_MODEL,
      rejectedReasonCode: "invalid_backstory_response",
    });
    return { status: "accepted", facts: attempt.value };
  } catch (error) {
    if (
      error instanceof UsagePersistenceError ||
      (error instanceof Error && error.name === "UsagePersistenceError")
    ) {
      throw error;
    }
    return { status: "failed" };
  }
}

// Public fail-open convenience for callers that only need the facts. Durable
// caching uses the discriminated internal result above so a transient failure
// can never become a permanent no-facts sentinel.
export async function extractBiographicalFacts(
  opts: BackstoryExtractionOptions,
): Promise<string[]> {
  const result = await runBackstoryExtraction(opts);
  return result.status === "accepted" ? result.facts : [];
}

// Lazy + cached: return the profile with biographical_facts populated. If the
// profile already has them, no-op. Otherwise extract once, persist onto the
// stored profile JSON, and return the enriched profile. Persistence failure is
// non-fatal — we still return the enriched profile in-memory for this turn.
//
// Persisting a sentinel: when extraction returns ZERO facts, we still persist a
// marker so we don't re-run the (paid) extraction every turn for a profile that
// genuinely has no biographical anchors. We use a single-element sentinel
// array that the render layer treats as empty. Kept internal + explicit.
export const NO_FACTS_SENTINEL = "__no_biographical_facts__";

export async function ensureBiographicalFacts(opts: {
  workspaceId: string;
  profile: VoiceProfile;
  signal?: AbortSignal;
  telemetry?: CoworkTurnTelemetry;
  adapterHealth?: AdapterHealthRegistry;
}): Promise<VoiceProfile> {
  // Already resolved (has facts OR the sentinel) → no-op.
  if (opts.profile.biographical_facts !== undefined) return opts.profile;
  if (!backstoryEnabled()) return opts.profile;

  const extraction = await runBackstoryExtraction({
    profile: opts.profile,
    workspaceId: opts.workspaceId,
    signal: opts.signal,
    telemetry: opts.telemetry,
    adapterHealth: opts.adapterHealth,
  });
  if (extraction.status === "failed") return opts.profile;
  const facts = extraction.facts;
  // Store the sentinel when empty so we don't pay for extraction every turn.
  const stored = facts.length ? facts : [NO_FACTS_SENTINEL];
  const enriched: VoiceProfile = {
    ...opts.profile,
    biographical_facts: stored,
  };

  // Persist onto the stored profile JSON. Best-effort — a write failure just
  // means we re-extract next turn (annoying, not broken).
  try {
    await supabaseAdmin()
      .from("voice_profiles")
      .update({ profile: enriched })
      .eq("workspace_id", opts.workspaceId);
  } catch {
    /* non-fatal — enriched profile still used for this turn */
  }
  return enriched;
}

// Render the biographical facts as a retrieval-layer prompt block. Returns ""
// when there are no real facts (empty or the sentinel), so the generation
// prompt is unchanged for a profile with no biographical anchors. Pure +
// exported so the exact injected text is unit-testable.
export function renderBackstoryBlock(
  facts: string[] | undefined,
): string {
  const real = (facts ?? []).filter(
    (f) => typeof f === "string" && f.trim() && f !== NO_FACTS_SENTINEL,
  );
  if (real.length === 0) return "";
  return [
    "BACKSTORY LIBRARY — use SPARINGLY, only when the topic genuinely calls for it:",
    ...real.map((f) => `  • ${f}`),
    "These are personal facts you MAY reference when a post's topic naturally connects to one of them — NOT a checklist to prove authenticity. Do NOT name-drop these unprompted. Most posts should reference NONE of them. Your voice is your rhythm and point of view; these facts are seasoning, used rarely, not the main dish.",
  ].join("\n");
}
