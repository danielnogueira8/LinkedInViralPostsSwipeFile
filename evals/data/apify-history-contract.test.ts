import { beforeEach, describe, expect, test, vi } from "vitest";

const logApifyUsage = vi.fn(async () => {});

vi.mock("@/lib/usage", () => ({ logApifyUsage }));

function scrapedItem(id: number) {
  return {
    full_urn: `urn:li:share:${id}`,
    text: `Post ${id}`,
  };
}

async function loadApify(actor: string) {
  vi.resetModules();
  vi.stubEnv("APIFY_ACTOR_ID", actor);
  vi.stubEnv("APIFY_API_TOKEN", "test-token");
  return import("@/lib/apify");
}

describe("runProfileHistory result and usage contract", () => {
  beforeEach(() => {
    logApifyUsage.mockClear();
  });

  test("caps harvestapi results even when the actor returns extra items", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify([scrapedItem(1), scrapedItem(2), scrapedItem(3)]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { runProfileHistory } = await loadApify(
      "harvestapi~linkedin-profile-posts",
    );
    await expect(runProfileHistory("Creator", 1)).resolves.toHaveLength(1);

    expect(logApifyUsage).toHaveBeenCalledWith(
      "voice_history",
      3,
      expect.objectContaining({ items: 3, raw_items: 3 }),
    );
  });

  test("charges for all paginated results before applying the history cap", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify([scrapedItem(11), scrapedItem(12), scrapedItem(13)]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { runProfileHistory } = await loadApify(
      "apimaestro~linkedin-profile-posts",
    );
    await expect(runProfileHistory("Creator", 2)).resolves.toHaveLength(2);

    expect(logApifyUsage).toHaveBeenCalledWith(
      "voice_history",
      3,
      expect.objectContaining({ items: 3, raw_items: 3 }),
    );
  });
});
