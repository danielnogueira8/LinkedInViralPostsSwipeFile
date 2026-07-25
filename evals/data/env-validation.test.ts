import { describe, expect, test } from "vitest";
import { validateEnv } from "@/lib/env";

const VALID = {
  NEXT_PUBLIC_SUPABASE_URL: "https://proj.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  OPENROUTER_API_KEY: "or-key",
  CRON_SECRET: "cron-secret",
};

describe("validateEnv", () => {
  test("returns the parsed required env when all are present", () => {
    const out = validateEnv(VALID);
    expect(out.OPENROUTER_API_KEY).toBe("or-key");
    expect(out.NEXT_PUBLIC_SUPABASE_URL).toBe("https://proj.supabase.co");
  });

  test("throws naming a single missing var", () => {
    const rest = { ...VALID };
    delete (rest as Partial<typeof VALID>).OPENROUTER_API_KEY;
    expect(() => validateEnv(rest)).toThrowError(/OPENROUTER_API_KEY: is required but not set/);
  });

  test("aggregates every problem into one error", () => {
    let msg = "";
    try {
      validateEnv({});
    } catch (e) {
      msg = (e as Error).message;
    }
    for (const key of Object.keys(VALID)) {
      expect(msg).toContain(key);
    }
    // A single throw, not one-per-var.
    expect(msg).toContain("cannot start");
  });

  test("rejects a non-URL Supabase URL", () => {
    expect(() => validateEnv({ ...VALID, NEXT_PUBLIC_SUPABASE_URL: "not-a-url" })).toThrowError(
      /NEXT_PUBLIC_SUPABASE_URL: must be a valid URL/,
    );
  });

  test("rejects an empty-string secret (present but blank)", () => {
    expect(() => validateEnv({ ...VALID, CRON_SECRET: "" })).toThrowError(/CRON_SECRET/);
  });

  test("ignores unknown/optional vars", () => {
    expect(() => validateEnv({ ...VALID, OPENROUTER_CHAT_MODEL: "x", RANDOM: "y" })).not.toThrow();
  });

  test("rejects Clerk development keys in a production deployment", () => {
    expect(() =>
      validateEnv({
        ...VALID,
        VERCEL_ENV: "production",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_example",
        CLERK_SECRET_KEY: "sk_test_example",
      }),
    ).toThrowError(/NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: must use a production Clerk key/);
    expect(() =>
      validateEnv({
        ...VALID,
        VERCEL_ENV: "production",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_example",
        CLERK_SECRET_KEY: "sk_test_example",
      }),
    ).toThrowError(/CLERK_SECRET_KEY: must use a production Clerk key/);
  });

  test("requires both Clerk keys in a production deployment", () => {
    expect(() => validateEnv({ ...VALID, VERCEL_ENV: "production" })).toThrowError(
      /NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: is required in production/,
    );
    expect(() => validateEnv({ ...VALID, VERCEL_ENV: "production" })).toThrowError(
      /CLERK_SECRET_KEY: is required in production/,
    );
  });

  test("accepts Clerk production keys in production and test keys in preview", () => {
    expect(() =>
      validateEnv({
        ...VALID,
        VERCEL_ENV: "production",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_example",
        CLERK_SECRET_KEY: "sk_live_example",
      }),
    ).not.toThrow();
    expect(() =>
      validateEnv({
        ...VALID,
        VERCEL_ENV: "preview",
        NODE_ENV: "production",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_example",
        CLERK_SECRET_KEY: "sk_test_example",
      }),
    ).not.toThrow();
  });

  test("rejects Clerk development keys for explicitly marked self-hosted production", () => {
    expect(() =>
      validateEnv({
        ...VALID,
        NODE_ENV: "production",
        SWIPEIN_DEPLOYMENT_ENV: "production",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_example",
        CLERK_SECRET_KEY: "sk_test_example",
      }),
    ).toThrowError(/must use a production Clerk key/);
  });

  test("does not mistake a local production build for a deployed environment", () => {
    expect(() =>
      validateEnv({
        ...VALID,
        NODE_ENV: "production",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_example",
        CLERK_SECRET_KEY: "sk_test_example",
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // AI_PROVIDER selection (boot-time validation of the active text provider).
  // The runtime gate is an exact `AI_PROVIDER === "anthropic"` check, so the
  // validation only demands an Anthropic key in exactly that configuration and
  // leaves every currently-booting configuration (unset / openrouter / other)
  // untouched.
  // -------------------------------------------------------------------------

  test("boots with AI_PROVIDER unset (default OpenRouter path) — no Anthropic key required", () => {
    // The fresh-checkout / default deploy: unset flag runs GLM/OpenRouter.
    expect(() => validateEnv(VALID)).not.toThrow();
  });

  test("boots with AI_PROVIDER=openrouter and no Anthropic key", () => {
    expect(() => validateEnv({ ...VALID, AI_PROVIDER: "openrouter" })).not.toThrow();
  });

  test("boots with an empty-string AI_PROVIDER (treated as unset → OpenRouter)", () => {
    expect(() => validateEnv({ ...VALID, AI_PROVIDER: "" })).not.toThrow();
  });

  test("requires an Anthropic key when AI_PROVIDER=anthropic", () => {
    expect(() => validateEnv({ ...VALID, AI_PROVIDER: "anthropic" })).toThrowError(
      /SWIPE_ANTHROPIC_KEY \(or ANTHROPIC_API_KEY\): is required when AI_PROVIDER=anthropic/,
    );
  });

  test("boots with AI_PROVIDER=anthropic when SWIPE_ANTHROPIC_KEY is present", () => {
    expect(() =>
      validateEnv({ ...VALID, AI_PROVIDER: "anthropic", SWIPE_ANTHROPIC_KEY: "sk-ant-1" }),
    ).not.toThrow();
  });

  test("boots with AI_PROVIDER=anthropic when the fallback ANTHROPIC_API_KEY is present", () => {
    expect(() =>
      validateEnv({ ...VALID, AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-2" }),
    ).not.toThrow();
  });

  test("rejects an anthropic flag with a blank key value (present but empty)", () => {
    expect(() =>
      validateEnv({ ...VALID, AI_PROVIDER: "anthropic", SWIPE_ANTHROPIC_KEY: "" }),
    ).toThrowError(/SWIPE_ANTHROPIC_KEY \(or ANTHROPIC_API_KEY\): is required when AI_PROVIDER=anthropic/);
  });

  test("rejects a typo'd / unrecognized AI_PROVIDER value", () => {
    expect(() => validateEnv({ ...VALID, AI_PROVIDER: "Anthropic" })).toThrowError(
      /AI_PROVIDER: must be one of anthropic, openrouter/,
    );
  });

  test("still requires OPENROUTER_API_KEY even when AI_PROVIDER=anthropic (embeddings/images)", () => {
    const rest = { ...VALID, AI_PROVIDER: "anthropic", SWIPE_ANTHROPIC_KEY: "sk-ant-1" };
    delete (rest as Partial<typeof rest>).OPENROUTER_API_KEY;
    expect(() => validateEnv(rest)).toThrowError(/OPENROUTER_API_KEY: is required but not set/);
  });
});
