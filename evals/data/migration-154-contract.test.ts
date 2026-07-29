import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const sql = fs.readFileSync(
  path.join(process.cwd(), "db/migration-154-source-post-count.sql"),
  "utf8",
);

describe("migration 154 canonical Source Post count", () => {
  test("counts eligible rows in the database with workspace fallback semantics", () => {
    expect(sql).toContain("count_source_posts");
    expect(sql).toContain("classification.post_id is null");
    expect(sql).toContain("classification.is_viral = true");
    expect(sql).toContain("post.is_viral = true");
    expect(sql).toContain("websearch_to_tsquery");
    expect(sql).toContain("post.baseline_score > 0");
    expect(sql).toContain("membership.workspace_id = p_workspace_id");
    expect(sql).toContain("security definer");
    expect(sql).toContain("to service_role");
    expect(sql).toMatch(/values\s*\(true,\s*154,\s*now\(\)\)/i);
  });
});
