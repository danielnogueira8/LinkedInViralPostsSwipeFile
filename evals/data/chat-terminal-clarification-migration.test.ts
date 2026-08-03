import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const sql = readFileSync(
  new URL(
    "../../db/migration-175-resolve-chat-terminal-clarification.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("terminal clarification migration", () => {
  test("serializes latest-message validation and the terminal update", () => {
    expect(sql).toContain("message.workspace_id = p_workspace_id");
    expect(sql).toContain("message.id = (\n      select latest.id");
    expect(sql).toContain("latest.role in ('user', 'assistant')");
    expect(sql).toContain("message.terminal_reason is null");
    expect(sql).toContain("message.terminal_reason = 'ask'");
    expect(sql).toContain("returning message.terminal_reason");
  });

  test("keeps the function private to the service role", () => {
    expect(sql).toContain(
      "from public, anon, authenticated",
    );
    expect(sql).toContain("to service_role");
    expect(sql).toContain("app_deployment_readiness_base_175");
    expect(sql).toContain("has_function_privilege");
    expect(sql).toContain("values (true, 175, now())");
  });
});
