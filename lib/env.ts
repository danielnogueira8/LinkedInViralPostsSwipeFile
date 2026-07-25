import { z } from "zod";

// ---------------------------------------------------------------------------
// Runtime environment validation. Env vars were read ad-hoc via process.env in
// ~50 places; a missing REQUIRED secret (Supabase, OpenRouter, CRON_SECRET)
// didn't fail at boot — it failed at the first request that needed it, as an
// opaque runtime 500. This module validates the required set ONCE at server
// startup (see instrumentation.ts) and throws a single, aggregated, readable
// error naming every missing/invalid var, so a fat-fingered prod config is
// caught at deploy time, not by a user.
//
// Scope is deliberately narrow: ONLY the vars the app cannot function without.
// The many optional tuning knobs (OPENROUTER_*_MODEL, AGENT_*_MS, VIRAL_*,
// HEALTH_DIGEST_WEBHOOK, direct-Anthropic keys, etc.) all have safe in-code
// defaults or are feature-gated, so requiring them here would break local/dev
// and preview for no benefit. They stay validated at their point of use.
// ---------------------------------------------------------------------------

// Required in every environment. These have no safe fallback — the app is
// broken without them.
const requiredEnvSchema = z.object({
  // Supabase (data layer). The URL is NEXT_PUBLIC_ (also used client-side);
  // the service-role key is server-only.
  NEXT_PUBLIC_SUPABASE_URL: z.string().url("must be a valid URL"),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  // OpenRouter — every LLM call routes through it.
  OPENROUTER_API_KEY: z.string().min(1),
  // Bearer secret guarding the cron endpoints (they fail closed without it,
  // so an unset value means every cron is 401 — the scrape/publish/queue all
  // silently stop).
  CRON_SECRET: z.string().min(1),
});

export type RequiredEnv = z.infer<typeof requiredEnvSchema>;

// Validate the required env. Returns the parsed values on success; throws a
// single aggregated Error listing every problem on failure. Pure over its
// `source` arg (defaults to process.env) so it's unit-testable without
// mutating the real environment.
export function validateEnv(source: Record<string, string | undefined> = process.env): RequiredEnv {
  const result = requiredEnvSchema.safeParse(source);
  const problems = result.success
    ? []
    : result.error.issues.map((issue) => {
      const name = issue.path.join(".");
      // A missing var shows up as an "invalid_type ... received undefined"
      // issue; give it a clearer label than Zod's default wording.
      const missing =
        issue.code === "invalid_type" &&
        source[name as keyof typeof source] === undefined;
      return `  - ${name}: ${missing ? "is required but not set" : issue.message}`;
    });

  // Clerk development and production instances do not share identities or
  // organizations. Let local/preview builds use test keys, but fail an explicit
  // production deployment (Vercel, or self-hosted with
  // SWIPEIN_DEPLOYMENT_ENV=production) before it can serve traffic with
  // credentials that trigger Clerk's development limits and wrong tenant.
  const isProductionDeployment =
    source.VERCEL_ENV === "production" ||
    source.SWIPEIN_DEPLOYMENT_ENV === "production";
  if (isProductionDeployment) {
    const clerkKeys = [
      ["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "pk_live_"],
      ["CLERK_SECRET_KEY", "sk_live_"],
    ] as const;
    for (const [name, livePrefix] of clerkKeys) {
      const value = source[name]?.trim();
      if (!value) {
        problems.push(`  - ${name}: is required in production`);
      } else if (!value.startsWith(livePrefix)) {
        problems.push(`  - ${name}: must use a production Clerk key`);
      }
    }
  }

  // AI provider selection. AI_PROVIDER switches the app's single text seam
  // (chat, writers, gates, specialists, and the vision model — everything that
  // resolves to a claude-* model) onto the Anthropic Messages API. The runtime
  // gate is an EXACT string check, `AI_PROVIDER === "anthropic"`
  // (lib/anthropic.ts `shouldUseAnthropic`), and under that flag numerous
  // surfaces default to hardcoded `anthropic/claude-*` models regardless of any
  // OPENROUTER_CHAT_MODEL pin — so whenever the flag is exactly "anthropic" the
  // Anthropic key is genuinely required or the app boots and then throws an
  // opaque 500 on the first Claude call (the SDK client is built with
  // apiKey: undefined). We validate against that exact semantics:
  //   - Only when AI_PROVIDER === "anthropic" do we require an Anthropic key
  //     (SWIPE_ANTHROPIC_KEY || ANTHROPIC_API_KEY — the exact pair the adapter
  //     reads). Unset, empty, or any other value keeps text on OpenRouter/GLM
  //     and needs no Anthropic key, so a fresh checkout / default deploy still
  //     boots untouched.
  //   - A set-but-unrecognized value (e.g. a "Anthropic"/"claude" typo) silently
  //     ran on OpenRouter while the operator believed they were on Anthropic;
  //     reject it so the misconfiguration surfaces at boot.
  // OPENROUTER_API_KEY stays required unconditionally above regardless of this
  // flag — embeddings and image generation ALWAYS route through OpenRouter.
  const aiProvider = source.AI_PROVIDER;
  if (aiProvider) {
    const allowedProviders = ["anthropic", "openrouter"];
    if (!allowedProviders.includes(aiProvider)) {
      problems.push(
        `  - AI_PROVIDER: must be one of ${allowedProviders.join(", ")} when set (leave unset to default to OpenRouter)`,
      );
    } else if (aiProvider === "anthropic") {
      const anthropicKey =
        source.SWIPE_ANTHROPIC_KEY || source.ANTHROPIC_API_KEY;
      if (!anthropicKey) {
        problems.push(
          "  - SWIPE_ANTHROPIC_KEY (or ANTHROPIC_API_KEY): is required when AI_PROVIDER=anthropic",
        );
      }
    }
  }

  if (result.success && problems.length === 0) return result.data;
  problems.sort();

  throw new Error(
    `Invalid environment configuration — the app cannot start:\n${problems.join("\n")}\n` +
      `Set these in your Vercel project (or .env.local for local dev) and redeploy.`,
  );
}
