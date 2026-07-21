import { describe, test, expect } from "vitest";
import { scrubSentryEvent } from "@/lib/sentry-config";

// ---------------------------------------------------------------------------
// The Sentry beforeSend scrubber must remove any secret that could ride into an
// event — most importantly the LeadShark x-api-key, which can arrive via a
// thrown fetch error's captured request headers/config.
// ---------------------------------------------------------------------------

describe("scrubSentryEvent", () => {
  test("redacts x-api-key nested in request headers", () => {
    const event = {
      request: { headers: { "x-api-key": "ls_live_SECRET", accept: "application/json" } },
    };
    const out = scrubSentryEvent(event) as typeof event;
    expect(out.request.headers["x-api-key"]).toBe("[redacted]");
    // Non-secret headers are untouched.
    expect(out.request.headers.accept).toBe("application/json");
  });

  test("redacts authorization headers and credential columns anywhere in the tree", () => {
    const event = {
      extra: {
        config: { headers: { Authorization: "Bearer abc" } },
        row: { ciphertext: "base64ciphertext", auth_tag: "tag", key_hint: "••••3f9a" },
      },
      breadcrumbs: [{ data: { api_key: "k-123" } }],
    };
    const out = scrubSentryEvent(event) as typeof event;
    expect(out.extra.config.headers.Authorization).toBe("[redacted]");
    expect(out.extra.row.ciphertext).toBe("[redacted]");
    expect(out.extra.row.auth_tag).toBe("[redacted]");
    expect(out.breadcrumbs[0].data.api_key).toBe("[redacted]");
    // key_hint is display-only (a hash tail) and safe to keep for debugging.
    expect(out.extra.row.key_hint).toBe("••••3f9a");
  });

  test("is case-insensitive on the key name", () => {
    const event = { extra: { "X-Api-Key": "SECRET", "API_KEY": "also" } };
    const out = scrubSentryEvent(event) as typeof event;
    expect(out.extra["X-Api-Key"]).toBe("[redacted]");
    expect(out.extra["API_KEY"]).toBe("[redacted]");
  });

  test("handles cyclic structures without throwing", () => {
    const a: Record<string, unknown> = { authorization: "secret" };
    a.self = a; // cycle
    const out = scrubSentryEvent(a) as Record<string, unknown>;
    expect(out.authorization).toBe("[redacted]");
  });

  test("leaves an event with no secrets structurally intact", () => {
    const event = { message: "boom", level: "error", tags: { route: "/x" } };
    expect(scrubSentryEvent(event)).toEqual(event);
  });
});
