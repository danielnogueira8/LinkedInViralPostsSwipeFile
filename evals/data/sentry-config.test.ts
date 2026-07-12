import { describe, expect, it } from "vitest";
import { createSentryOptions } from "@/lib/sentry-config";

describe("createSentryOptions", () => {
  it("stays disabled without a DSN and never sends default PII", () => {
    expect(
      createSentryOptions({
        dsn: undefined,
        environment: undefined,
        nodeEnv: "development",
      }),
    ).toMatchObject({
      enabled: false,
      environment: "development",
      sendDefaultPii: false,
      tracesSampleRate: 1,
    });
  });

  it("uses the deployment environment and conservative production sampling", () => {
    expect(
      createSentryOptions({
        dsn: "https://public@example.ingest.sentry.io/1",
        environment: "preview",
        nodeEnv: "production",
      }),
    ).toMatchObject({
      enabled: true,
      environment: "preview",
      tracesSampleRate: 0.1,
    });
  });
});
