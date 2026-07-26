import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const sql = readFileSync(
  new URL(
    "../../db/migration-135-restrict-revision-evidence.sql",
    import.meta.url,
  ),
  "utf8",
);
const evidenceSql = readFileSync(
  new URL("../../db/migration-128-preference-evidence.sql", import.meta.url),
  "utf8",
);

describe("migration 135 revision evidence privacy contract", () => {
  test("removes browser access to raw revision bodies", () => {
    expect(sql).toContain("drop policy if exists draft_edit_events_select");
    expect(sql).toMatch(
      /revoke select on table public\.draft_edit_events[\s\S]*authenticated/i,
    );
    expect(sql).not.toMatch(/grant select[\s\S]*authenticated/i);
  });

  test("keeps bounded evidence available only through the service RPC", () => {
    expect(evidenceSql).toContain("left(event.before_body, 1500)");
    expect(evidenceSql).toContain("left(event.after_body, 1500)");
    expect(evidenceSql).toMatch(
      /revoke all on function public\.list_content_preference_evidence[\s\S]*authenticated/i,
    );
    expect(evidenceSql).toMatch(
      /grant execute on function public\.list_content_preference_evidence[\s\S]*service_role/i,
    );
  });

  test("advances the schema version", () => {
    expect(sql).toMatch(
      /values\s*\(\s*true\s*,\s*135\s*,\s*now\(\)\s*\)/i,
    );
  });
});
