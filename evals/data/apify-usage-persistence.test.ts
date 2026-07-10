import { beforeEach, describe, expect, test, vi } from "vitest";

let releaseUsage: (() => void) | null = null;
const logApifyUsage = vi.fn(
  () =>
    new Promise<void>((resolve) => {
      releaseUsage = resolve;
    }),
);

vi.mock("@/lib/usage", () => ({ logApifyUsage }));

const { runOneProfile } = await import("@/lib/apify");

describe("Apify scrape usage persistence", () => {
  beforeEach(() => {
    releaseUsage = null;
    logApifyUsage.mockClear();
    vi.stubEnv("APIFY_API_TOKEN", "test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify([{ shareUrn: "urn:li:share:123" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
  });

  test("does not finish a profile scrape before its gating usage event", async () => {
    let settled = false;
    const scrape = runOneProfile("CreatorName").then((result) => {
      settled = true;
      return result;
    });

    await vi.waitFor(() => expect(logApifyUsage).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseUsage?.();
    await expect(scrape).resolves.toHaveLength(1);
    expect(logApifyUsage).toHaveBeenCalledWith(
      "profile_posts",
      1,
      expect.objectContaining({ username: "creatorname" }),
    );
  });
});
