import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  isManualAccountLimitError,
  MANUAL_ACCOUNT_LIMIT_MESSAGE,
} from "@/lib/account-tracking";

describe("manual account capacity enforcement", () => {
  test("recognizes only the dedicated database capacity error", () => {
    expect(
      isManualAccountLimitError({
        code: "P0001",
        message: "manual_account_limit:50",
      }),
    ).toBe(true);
    expect(isManualAccountLimitError({ code: "P0001", message: "other" })).toBe(false);
    expect(MANUAL_ACCOUNT_LIMIT_MESSAGE).toMatch(/50 manually-added creator limit/i);
  });

  test("migration serializes and enforces every manual membership insert", () => {
    const sql = readFileSync(
      resolve(process.cwd(), "db/migration-074-manual-account-tracking-cap.sql"),
      "utf8",
    );

    expect(sql).toMatch(/before insert on workspace_accounts/i);
    expect(sql).toMatch(/for each row execute function enforce_workspace_manual_account_limit/i);
    expect(sql).toMatch(/pg_advisory_xact_lock/i);
    expect(sql).toMatch(/a\.source = 'manual'/i);
    expect(sql).toMatch(/if v_count >= v_limit/i);
    expect(sql).toMatch(/manual_account_limit:%/i);
  });
});
