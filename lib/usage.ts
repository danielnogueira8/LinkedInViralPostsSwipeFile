import { supabaseAdmin } from "./supabase";

// Pricing (USD per million tokens). Update if Anthropic changes rates.
const ANTHROPIC_PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-opus-4-7": { input: 15, output: 75 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
};

// Apify actor pricing. Most actors on Apify are pay-per-result (PPR).
// Add new actors here as we use them. "unit" describes what `units` means
// for that actor — either "result" (PPR) or "cu" (compute units).
export type ApifyActorPricing = { unit: "result" | "cu"; pricePerUnit: number };

const APIFY_PRICING: Record<string, ApifyActorPricing> = {
  // apimaestro/linkedin-profile-posts: $5 per 1000 posts = $0.005 per post
  "apimaestro~linkedin-profile-posts": { unit: "result", pricePerUnit: 0.005 },
};

// Default if we hit an unknown actor: assume compute units at $0.40/CU
const DEFAULT_APIFY: ApifyActorPricing = { unit: "cu", pricePerUnit: 0.4 };

export function anthropicCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = ANTHROPIC_PRICING[model] ?? ANTHROPIC_PRICING["claude-sonnet-4-6"];
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

export function apifyCost(units: number, actor?: string): number {
  const p = (actor && APIFY_PRICING[actor]) || DEFAULT_APIFY;
  return units * p.pricePerUnit;
}

export async function logAnthropicUsage(
  kind: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  meta?: Record<string, unknown>,
) {
  try {
    const cost = anthropicCost(model, inputTokens, outputTokens);
    const sb = supabaseAdmin();
    await sb.from("usage_events").insert({
      provider: "anthropic",
      kind,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: cost,
      meta: meta ?? null,
    });
  } catch (e) {
    console.error("usage log fail", (e as Error).message);
  }
}

export async function logApifyUsage(
  kind: string,
  units: number,
  meta?: Record<string, unknown>,
) {
  try {
    const actor = process.env.APIFY_ACTOR_ID || "apimaestro~linkedin-profile-posts";
    const cost = apifyCost(units, actor);
    const sb = supabaseAdmin();
    await sb.from("usage_events").insert({
      provider: "apify",
      kind,
      units,
      cost_usd: cost,
      meta: { actor, ...(meta ?? {}) },
    });
  } catch (e) {
    console.error("usage log fail", (e as Error).message);
  }
}
