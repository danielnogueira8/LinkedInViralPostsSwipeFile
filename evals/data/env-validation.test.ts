import { describe, expect, test } from "vitest";
import { validateEnv } from "@/lib/env";

const VALID = {
  NEXT_PUBLIC_SUPABASE_URL: "https://proj.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  OPENAI_API_KEY: "openai-key",
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

  test("boots with native OpenAI and OpenRouter keys", () => {
    expect(() => validateEnv(VALID)).not.toThrow();
  });

  test("treats an empty AI_PROVIDER as unset", () => {
    expect(() => validateEnv({ ...VALID, AI_PROVIDER: "" })).not.toThrow();
  });

  test("rejects the obsolete AI_PROVIDER switch", () => {
    expect(() => validateEnv({ ...VALID, AI_PROVIDER: "anthropic" })).toThrowError(
      /AI_PROVIDER: is obsolete/,
    );
  });

  test("still requires OPENROUTER_API_KEY for configured non-OpenAI image models", () => {
    const rest = { ...VALID };
    delete (rest as Partial<typeof rest>).OPENROUTER_API_KEY;
    expect(() => validateEnv(rest)).toThrowError(/OPENROUTER_API_KEY: is required but not set/);
  });
});
