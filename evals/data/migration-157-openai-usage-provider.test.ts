import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const sql = readFileSync(
  "db/migration-157-openai-usage-provider.sql",
  "utf8",
);

describe("migration 157 OpenAI usage provider", () => {
  test("allows native OpenAI usage without removing historical providers", () => {
    expect(sql).toMatch(/drop constraint if exists usage_events_provider_check/i);
    expect(sql).toMatch(
      /check\s*\(provider in\s*\('anthropic', 'apify', 'openai', 'openrouter', 'zernio'\)\)/i,
    );
  });

  test("advances deployment readiness to schema 157", () => {
    expect(sql).toMatch(/values \(true, 157, now\(\)\)/i);
  });
});
