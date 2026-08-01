import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

describe("LinkedIn embed probe timeout cleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("clears each request timeout when fetch rejects", async () => {
    const { probeEmbedUrn } = await import("@/lib/linkedin-url");

    await expect(probeEmbedUrn("123")).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
