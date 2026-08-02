import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL(
    "../../db/migration-174-agent-loop-search-cache.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("agent loop search cache migration", () => {
  it("stores paid-search results separately from synthesis completion", () => {
    expect(sql).toContain("add column if not exists search_payload jsonb");
    expect(sql).toContain(
      "add column if not exists synthesis_completed_at timestamptz",
    );
    expect(sql).toContain(
      "add column if not exists synthesis_claim_token uuid",
    );
    expect(sql).toContain("claim_agent_loop_daily_synthesis");
    expect(sql).toContain("and synthesis_claim_token is null");
    expect(sql).not.toContain("p_stale_before");
    expect(sql).toContain("values (true, 174, now())");
  });
});
