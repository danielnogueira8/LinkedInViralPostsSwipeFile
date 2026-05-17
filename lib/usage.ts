import { supabaseAdmin } from "./supabase";

// Pricing (USD per million tokens). Update if Anthropic changes rates.
const ANTHROPIC_PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-opus-4-7": { input: 15, output: 75 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
};

// Apify compute units priced per CU (starter plan default)
const APIFY_PER_CU = 0.4;

export function anthropicCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = ANTHROPIC_PRICING[model] ?? ANTHROPIC_PRICING["claude-sonnet-4-6"];
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

export function apifyCost(computeUnits: number): number {
  return computeUnits * APIFY_PER_CU;
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
  computeUnits: number,
  meta?: Record<string, unknown>,
) {
  try {
    const cost = apifyCost(computeUnits);
    const sb = supabaseAdmin();
    await sb.from("usage_events").insert({
      provider: "apify",
      kind,
      units: computeUnits,
      cost_usd: cost,
      meta: meta ?? null,
    });
  } catch (e) {
    console.error("usage log fail", (e as Error).message);
  }
}
