import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  BACKGROUND_JOB_TYPES,
  enqueueBackgroundJob,
  isBackgroundJobType,
  type BackgroundJobType,
} from "@/lib/background-jobs";

describe("background job type contract", () => {
  test("only advertises job types with runnable worker handlers", () => {
    expect(BACKGROUND_JOB_TYPES).not.toContain("lead_magnet_resource");
    expect(isBackgroundJobType("lead_magnet_resource")).toBe(false);
    expect(isBackgroundJobType("lead_magnet_image")).toBe(true);
  });

  test("rejects an untyped caller before touching the database", async () => {
    const from = () => {
      throw new Error("database should not be reached");
    };

    await expect(
      enqueueBackgroundJob({
        workspaceId: "ws-1",
        type: "lead_magnet_resource" as BackgroundJobType,
        sb: { from } as never,
      }),
    ).rejects.toThrow("Unsupported background job type 'lead_magnet_resource'.");
  });

  test("retires queued legacy resource jobs before closing the DB enqueue seam", () => {
    const sql = readFileSync(
      "db/migration-123-retire-lead-magnet-resource-job.sql",
      "utf8",
    );

    expect(sql).toMatch(
      /update\s+public\.background_jobs[\s\S]*type\s*=\s*'lead_magnet_resource'[\s\S]*status\s+in\s*\(\s*'queued'\s*,\s*'running'\s*\)/i,
    );
    expect(sql).toMatch(
      /'lead_magnet_resource'[\s\S]*status\s+in\s*\(\s*'done'\s*,\s*'failed'\s*,\s*'cancelled'\s*\)/i,
    );
    const currentSql = readFileSync(
      "db/migration-149-knowledge-extraction.sql",
      "utf8",
    );
    for (const type of BACKGROUND_JOB_TYPES) {
      expect(currentSql).toContain(`'${type}'`);
    }
    expect(sql).toMatch(/values\s*\(\s*true\s*,\s*123\s*,/i);
  });
});
