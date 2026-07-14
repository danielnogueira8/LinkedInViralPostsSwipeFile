import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDb(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "migration-check-"));
  created.push(dir);
  for (const file of files) writeFileSync(join(dir, file), "-- test\n");
  return dir;
}

function fixture(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "migration-readiness-"));
  created.push(dir);
  const file = join(dir, "response.json");
  writeFileSync(file, contents);
  return file;
}

function check(dir: string, write = false) {
  return spawnSync(process.execPath, [
    "scripts/check-migrations.mjs",
    `--dir=${dir}`,
    ...(write ? ["--write"] : []),
  ], { cwd: process.cwd(), encoding: "utf8" });
}

function chainThrough87(latestSql: string): string {
  const files = Array.from({ length: 87 }, (_, index) =>
    `migration-${String(index + 1).padStart(3, "0")}-test.sql`);
  const dir = tempDb(files);
  writeFileSync(join(dir, files.at(-1)!), latestSql);
  return dir;
}

describe("migration checker commands", () => {
  it("writes and verifies metadata for a contiguous chain", () => {
    const dir = tempDb(["migration-001-one.sql", "migration-002-two.sql"]);
    expect(check(dir, true).status).toBe(0);
    const result = check(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("001..002");
  });

  it("fails with a diagnostic for a missing version", () => {
    const dir = tempDb(["migration-001-one.sql", "migration-003-three.sql"]);
    const result = check(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing migration version: 002");
  });

  it("rejects migration version 000", () => {
    const dir = tempDb(["migration-000-zero.sql", "migration-001-one.sql"]);
    const result = check(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("versions must start at 001");
  });

  it("rejects structurally unbalanced SQL", () => {
    const dir = tempDb(["migration-001-one.sql"]);
    writeFileSync(join(dir, "migration-001-one.sql"), "select (1));\n");
    const result = check(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unbalanced parentheses");
  });

  it("requires the latest migration to advance the schema marker", () => {
    const dir = chainThrough87("-- no marker\n");
    const result = check(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must advance app_schema_version to 87");
  });

  it.each([
    ["comment", "-- insert into app_schema_version (singleton, version, updated_at) values (true, 87, now());\n"],
    ["wrong table", "insert into unrelated_table (singleton, version, updated_at) values (true, 87, now());\n"],
    ["function body", "do $$ begin insert into app_schema_version (singleton, version, updated_at) values (true, 87, now()); end $$;\n"],
  ])("rejects a marker present only in a %s", (_name, sql) => {
    const result = check(chainThrough87(sql));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must advance app_schema_version to 87");
  });

  it.each([
    ["string", "select 'unterminated;\n", "unterminated string quote"],
    ["identifier", "select \"unterminated;\n", "unterminated identifier quote"],
    ["block comment", "select 1; /* unterminated\n", "unterminated block comment"],
    ["dollar quote", "do $$ begin null;\n", "unterminated dollar quote"],
  ])("rejects an unterminated %s", (_name, sql, diagnostic) => {
    const dir = tempDb(["migration-001-one.sql"]);
    writeFileSync(join(dir, "migration-001-one.sql"), sql);
    const result = check(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(diagnostic);
  });

  it("fails when committed metadata drifts", () => {
    const dir = tempDb(["migration-001-one.sql"]);
    expect(check(dir, true).status).toBe(0);
    writeFileSync(join(dir, "migration-002-two.sql"), "-- new\n");
    const result = check(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("migrations.json is stale");
  });

  it("readiness reports missing configuration without printing secrets", () => {
    const env = { ...process.env };
    delete env.NEXT_PUBLIC_SUPABASE_URL;
    delete env.SUPABASE_SERVICE_ROLE_KEY;
    const result = spawnSync(process.execPath, ["scripts/migration-readiness.mjs"], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("expected=89 applied=unknown configuration=missing");
  });

  it.each([
    ["matching schema", { applied_version: 89, missing_capabilities: [] }, 0, "missing_capabilities=none"],
    ["old schema", { applied_version: 88, missing_capabilities: [] }, 1, "applied=88"],
    ["missing capability", { applied_version: 0, missing_capabilities: ["claim_chat_turn(text)"] }, 1, "claim_chat_turn(text)"],
  ])("reports %s with a stable exit status", (_name, payload, status, diagnostic) => {
    const file = fixture(JSON.stringify(payload));
    const result = spawnSync(process.execPath, ["scripts/migration-readiness.mjs", `--fixture=${file}`], {
      cwd: process.cwd(), encoding: "utf8",
    });
    expect(result.status).toBe(status);
    expect(result.stdout).toContain(diagnostic);
  });

  it("reports unavailable and malformed readiness responses", () => {
    const unavailable = fixture("{}");
    const unavailableResult = spawnSync(process.execPath, [
      "scripts/migration-readiness.mjs", `--fixture=${unavailable}`, "--fixture-status=404",
    ], { cwd: process.cwd(), encoding: "utf8" });
    expect(unavailableResult.status).toBe(1);
    expect(unavailableResult.stderr).toContain("rpc=unavailable status=404");

    const malformed = fixture("not json");
    const malformedResult = spawnSync(process.execPath, [
      "scripts/migration-readiness.mjs", `--fixture=${malformed}`,
    ], { cwd: process.cwd(), encoding: "utf8" });
    expect(malformedResult.status).toBe(2);
    expect(malformedResult.stderr).toContain("response=invalid");
  });

  it("reports connection failures without exposing credentials", () => {
    const secret = "not-a-real-service-role-key";
    const result = spawnSync(process.execPath, ["scripts/migration-readiness.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1",
        SUPABASE_SERVICE_ROLE_KEY: secret,
      },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("connection=failed");
    expect(result.stderr).not.toContain(secret);
  });
});
