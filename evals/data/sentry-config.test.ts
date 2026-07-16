import { describe, expect, it } from "vitest";
import { createSentryOptions } from "@/lib/sentry-config";

describe("createSentryOptions", () => {
  it("keeps local development out of the production Sentry project", () => {
    expect(
      createSentryOptions({
        dsn: undefined,
        environment: undefined,
        nodeEnv: "development",
      }),
    ).toMatchObject({
      enabled: false,
      dsn: expect.stringContaining("4511721960702032"),
      environment: "development",
      sendDefaultPii: false,
      tracesSampleRate: 0,
    });
  });

  it("keeps preview deployments out of the production Sentry project", () => {
    expect(
      createSentryOptions({
        dsn: "https://public@example.ingest.sentry.io/1",
        environment: "preview",
        nodeEnv: "production",
      }),
    ).toMatchObject({
      enabled: false,
      environment: "preview",
      tracesSampleRate: 0,
    });
  });

  it("enables conservative sampling only for production deployments", () => {
    expect(
      createSentryOptions({
        dsn: "https://public@example.ingest.sentry.io/1",
        environment: "production",
        nodeEnv: "production",
        release: "67d093b",
      }),
    ).toMatchObject({
      enabled: true,
      environment: "production",
      release: "67d093b",
      initialScope: { tags: { deployment_id: "67d093b" } },
      tracesSampleRate: 0.1,
    });
  });
});
