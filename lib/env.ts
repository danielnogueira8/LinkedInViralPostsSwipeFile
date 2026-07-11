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
  if (result.success) return result.data;

  const problems = result.error.issues
    .map((issue) => {
      const name = issue.path.join(".");
      // A missing var shows up as an "invalid_type ... received undefined"
      // issue; give it a clearer label than Zod's default wording.
      const missing =
        issue.code === "invalid_type" &&
        source[name as keyof typeof source] === undefined;
      return `  - ${name}: ${missing ? "is required but not set" : issue.message}`;
    })
    .sort();

  throw new Error(
    `Invalid environment configuration — the app cannot start:\n${problems.join("\n")}\n` +
      `Set these in your Vercel project (or .env.local for local dev) and redeploy.`,
  );
}
