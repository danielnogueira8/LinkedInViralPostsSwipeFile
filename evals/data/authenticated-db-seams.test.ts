import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const APP = resolve(ROOT, "app");

const ALLOWED_ADMIN_APP_FILES = new Set([
  "app/api/analytics/refresh/route.ts", // global service-only refresh lease
  "app/api/backfill-hooks/route.ts",
  "app/api/backfill-post-types/route.ts",
  "app/api/backfill-status/route.ts",
  "app/api/cron/agent-loop/route.ts",
  "app/api/cron/daily-recovery/route.ts",
  "app/api/cron/daily/route.ts",
  "app/api/cron/edit-delta-distill/route.ts",
  "app/api/health/route.ts",
  "app/api/internal/jobs/health/route.ts",
  "app/lm/[slug]/page.tsx", // intentionally public resource lookup
]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe("authenticated database seams", () => {
  test("app request surfaces cannot acquire the unrestricted admin client", () => {
    const offenders = sourceFiles(APP)
      .filter((path) => readFileSync(path, "utf8").includes("supabaseAdmin("))
      .map((path) => relative(ROOT, path))
      .filter((path) => !ALLOWED_ADMIN_APP_FILES.has(path));

    expect(offenders).toEqual([]);
  });

  test("the scoped client retains explicit workspace predicates", () => {
    const source = readFileSync(resolve(ROOT, "lib/supabase-scoped.ts"), "utf8");

    expect(source).toContain('.eq("workspace_id", workspaceId)');
    expect(source).toContain("const sb = supabaseAdmin();");
    expect(source).not.toMatch(/raw:\s*supabaseAdmin\(\)/);
  });

  test("request capabilities do not expose service-role table or storage builders", () => {
    const source = readFileSync(resolve(ROOT, "lib/supabase.ts"), "utf8");

    expect(source).not.toContain("REQUEST_SERVICE_ROLE_TABLES");
    expect(source).not.toContain("REQUEST_SERVICE_ROLE_BUCKETS");
    expect(source).not.toMatch(/serviceClient\.from\(/);
    expect(source).not.toMatch(/serviceClient\.storage/);
  });

  test("authenticated publishing-connection reads inject their scoped client", () => {
    const offenders = sourceFiles(APP).flatMap((path) => {
      const source = readFileSync(path, "utf8");
      if (!source.includes("getConnection(")) return [];
      return /getConnection\([^,\n)]+\)/.test(source) ? [relative(ROOT, path)] : [];
    });

    expect(offenders).toEqual([]);
  });
});
