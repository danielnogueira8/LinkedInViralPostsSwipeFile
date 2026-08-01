import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

import {
  cronAuthorizationResponse,
  isCronAuthorized,
} from "@/app/api/cron/_auth";

const CRON_ROUTES = [
  "daily-recovery",
  "daily",
  "edit-delta-distill",
  "jobs",
  "pattern-briefs",
  "publish-scheduled",
  "sweep-media",
] as const;

function request(authorization?: string): Request {
  return new Request("https://example.com/api/cron/test", {
    headers: authorization ? { authorization } : undefined,
  });
}

describe("shared non-agent cron authorization", () => {
  test("fails closed when the secret is absent or the bearer token is wrong", () => {
    delete process.env.CRON_SECRET;
    expect(isCronAuthorized(request("Bearer secret"))).toBe(false);

    process.env.CRON_SECRET = "secret";
    expect(isCronAuthorized(request())).toBe(false);
    expect(isCronAuthorized(request("Bearer wrong"))).toBe(false);
  });

  test("accepts only the configured bearer token", () => {
    process.env.CRON_SECRET = "secret";
    expect(isCronAuthorized(request("Bearer secret"))).toBe(true);
    expect(isCronAuthorized(request("Basic secret"))).toBe(false);
  });

  test("returns the stable unauthorized response used by cron adapters", async () => {
    const response = cronAuthorizationResponse();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "unauthorized",
    });
  });

  test("all assigned cron adapters use the shared policy seam", () => {
    for (const route of CRON_ROUTES) {
      const source = readFileSync(
        `app/api/cron/${route}/route.ts`,
        "utf8",
      );
      expect(source).toContain("cronAuthorizationResponse");
      expect(source).toContain("isCronAuthorized");
      expect(source).not.toContain("process.env.CRON_SECRET");
    }
  });
});
