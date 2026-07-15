import { describe, expect, test, vi } from "vitest";
import {
  AdapterCircuitOpenError,
  AdapterHealthRegistry,
  classifyAdapterFailure,
  runHealthyAdapter,
} from "@/lib/agent/adapter-health";

describe("Cowork adapter health circuits", () => {
  test("opens a rolling error circuit, permits one half-open probe, and recovers without flapping", () => {
    let now = 1_000;
    const health = new AdapterHealthRegistry({
      windowSize: 4,
      minimumSamples: 4,
      failureRateToOpen: 0.5,
      slowRateToOpen: 1,
      slowLatencyMs: 10_000,
      openCooldownMs: 5_000,
      halfOpenSuccessesToClose: 2,
      now: () => now,
    });
    const key = "writer:qwen";

    for (let index = 0; index < 2; index += 1) {
      expect(health.acquire(key).allowed).toBe(true);
      health.recordSuccess(key, 100);
    }
    for (let index = 0; index < 2; index += 1) {
      expect(health.acquire(key).allowed).toBe(true);
      health.recordFailure(key, "provider_5xx", 100);
    }

    expect(health.snapshot(key).state).toBe("open");
    expect(health.acquire(key)).toMatchObject({ allowed: false, state: "open" });
    now += 5_001;
    expect(health.acquire(key)).toMatchObject({ allowed: true, state: "half_open" });
    expect(health.acquire(key)).toMatchObject({ allowed: false, state: "half_open" });
    health.recordSuccess(key, 90);
    expect(health.acquire(key)).toMatchObject({ allowed: true, state: "half_open" });
    health.recordSuccess(key, 80);
    expect(health.snapshot(key).state).toBe("closed");
  });

  test("opens on a sustained slow window and cancellation does not poison health", () => {
    const health = new AdapterHealthRegistry({
      windowSize: 3,
      minimumSamples: 3,
      failureRateToOpen: 1,
      slowRateToOpen: 2 / 3,
      slowLatencyMs: 500,
      openCooldownMs: 1_000,
      halfOpenSuccessesToClose: 1,
      now: () => 1_000,
    });
    const key = "planner:sonnet";
    expect(health.acquire(key).allowed).toBe(true);
    health.recordSuccess(key, 700);
    expect(health.acquire(key).allowed).toBe(true);
    health.release(key);
    expect(health.acquire(key).allowed).toBe(true);
    health.recordSuccess(key, 800);
    expect(health.acquire(key).allowed).toBe(true);
    health.recordSuccess(key, 100);
    expect(health.snapshot(key).state).toBe("open");
  });

  test("a stale closed-request completion cannot release or recover the half-open probe", () => {
    let now = 1_000;
    const health = new AdapterHealthRegistry({
      minimumSamples: 1,
      failureRateToOpen: 1,
      slowRateToOpen: 1,
      slowLatencyMs: 10_000,
      openCooldownMs: 100,
      halfOpenSuccessesToClose: 1,
      now: () => now,
    });
    const key = "writer:overlap";
    const stale = health.acquire(key);
    const opener = health.acquire(key);

    health.recordFailure(key, "provider_5xx", 5, opener);
    now += 101;
    const probe = health.acquire(key);
    expect(probe).toMatchObject({ allowed: true, state: "half_open" });

    health.recordSuccess(key, 5, stale);
    health.release(key, stale);
    expect(health.acquire(key)).toMatchObject({
      allowed: false,
      state: "half_open",
    });

    health.recordSuccess(key, 5, probe);
    expect(health.snapshot(key).state).toBe("closed");
  });

  test("classifies bounded provider failures without logging their messages", () => {
    expect(classifyAdapterFailure(Object.assign(new Error("private"), { status: 429 }))).toBe("rate_limit");
    expect(classifyAdapterFailure(Object.assign(new Error("private"), { code: 503 }))).toBe("provider_5xx");
    expect(classifyAdapterFailure(new DOMException("private", "TimeoutError"))).toBe("timeout");
    expect(classifyAdapterFailure(new Error("OpenRouter 503 Service Unavailable"))).toBe("provider_5xx");
    expect(new AdapterCircuitOpenError("writer:qwen").code).toBe("adapter_circuit_open");
  });

  test("an already-aborted signal never acquires or invokes an adapter", async () => {
    const health = new AdapterHealthRegistry();
    const controller = new AbortController();
    controller.abort();
    const call = vi.fn(async () => "unused");

    await expect(
      runHealthyAdapter({
        registry: health,
        key: "writer:cancelled",
        signal: controller.signal,
        call,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(call).not.toHaveBeenCalled();
    expect(health.snapshot("writer:cancelled")).toMatchObject({
      state: "closed",
      samples: 0,
    });
  });
});
