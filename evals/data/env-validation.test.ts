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
});
