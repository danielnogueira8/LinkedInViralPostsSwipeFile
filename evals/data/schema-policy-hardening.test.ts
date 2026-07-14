import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const migrationPath = "db/migration-091-schema-policy-hardening.sql";

function policyStatement(sql: string, name: string): string {
  const statement = sql.match(
    new RegExp(`create\\s+policy\\s+${name}\\b[\\s\\S]*?;`, "i"),
  )?.[0];
  expect(statement, `missing policy ${name}`).toBeDefined();
  return statement!;
}

describe("migration 091 schema and policy hardening", () => {
  test("binds shared-library access to the exact Clerk user", () => {
    expect(existsSync(migrationPath)).toBe(true);
    const sql = readFileSync(migrationPath, "utf8");

    expect(sql).toMatch(/create or replace function public\.auth_user_id\(\)/i);
    expect(sql).toMatch(/recipient_user_id\s*=\s*public\.auth_user_id\(\)/i);
    expect(sql).not.toMatch(/recipient_user_id\s+is\s+not\s+null/i);
    expect(policyStatement(sql, "shared_bookmarks_owner_or_recipient")).toMatch(/for select/i);
    expect(policyStatement(sql, "shared_bookmarks_owner_write")).toMatch(/for all/i);
    expect(policyStatement(sql, "saved_posts_isolation")).toMatch(/for select/i);
    expect(policyStatement(sql, "saved_posts_owner_write")).toMatch(/for all/i);
  });

  test("closes anonymous access to global runs and backfill state", () => {
    const sql = readFileSync(migrationPath, "utf8");

    expect(sql).toMatch(/alter table public\.runs enable row level security/i);
    expect(sql).toMatch(/public\.auth_workspace_id\(\)\s+is\s+not\s+null[\s\S]*workspace_id\s+is\s+null/i);
    expect(sql).toMatch(/alter table public\.backfill_runs enable row level security/i);
    expect(sql).toMatch(/revoke all on table public\.backfill_runs from anon, authenticated/i);
  });

  test("repairs physical drift and advances the schema version", () => {
    const sql = readFileSync(migrationPath, "utf8");

    expect(sql).toMatch(/alter table public\.categories[\s\S]*add column if not exists created_at/i);
    expect(sql).toMatch(/values\s*\(\s*true\s*,\s*91\s*,/i);
  });

  test("extends readiness across policy, RLS, trigger, and index drift", () => {
    const sql = readFileSync(migrationPath, "utf8");

    expect(sql).toMatch(/create or replace function public\.app_deployment_readiness\(\)/i);
    expect(sql).toMatch(/\('public\.categories', 'created_at'\)/);
    expect(sql).toMatch(/\('public\.accounts', 'manual_owner_workspace_id'\)/);
    expect(sql).toMatch(/\('public\.publishing_connections', 'profile_claim_token'\)/);
    expect(sql).toMatch(/\('public\.post_embeddings', 'embedding'\)/);
    expect(sql).toMatch(/\('public\.saved_posts', 'saved_posts_isolation', 'r'/);
    expect(sql).toMatch(/\('public\.hooks', 'hooks_read_via_tracking', 'r'/);
    expect(sql).toMatch(/\('public\.accounts', 'protect_account_niche_trg'/);
    expect(sql).toMatch(/\('public\.workspace_accounts', 'workspace_accounts_manual_limit'/);
    expect(sql).toMatch(/\('public\.accounts', 'accounts_linkedin_handle_ci_unique', 'btree', true/);
    expect(sql).toMatch(/\('public\.post_embeddings', 'post_embeddings_cosine_idx', 'ivfflat', false/);
    expect(sql).toMatch(/not c\.relrowsecurity/);
    expect(sql).toMatch(/p\.polroles\s*=\s*array\[0::oid\]/);
    expect(sql).toMatch(/pg_get_expr\(p\.polwithcheck/);
    expect(sql).toMatch(/unexpected_policies as/);
  });
});
