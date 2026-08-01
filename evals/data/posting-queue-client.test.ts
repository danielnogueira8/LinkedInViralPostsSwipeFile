import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fetchPostingQueueSnapshot } from "@/lib/posting-queue-client";

const snapshot = {
  ok: true as const,
  collapsed: false,
  timeVariationEnabled: true,
  slots: [],
  drafts: [],
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchPostingQueueSnapshot", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("shares one fresh request between concurrent callers", async () => {
    let resolveResponse!: (value: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchMock = vi.mocked(fetch).mockReturnValue(pendingResponse);

    const first = fetchPostingQueueSnapshot("Europe/Lisbon");
    const second = fetchPostingQueueSnapshot("Europe/Lisbon");

    expect(first).toBe(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/posting-slots?timezone=Europe%2FLisbon",
      { cache: "no-store" },
    );

    resolveResponse(response(snapshot));
    await expect(first).resolves.toEqual({
      collapsed: false,
      timeVariationEnabled: true,
      slots: [],
      drafts: [],
    });
  });

  test("keeps different timezones independent", async () => {
    const fetchMock = vi
      .mocked(fetch)
      .mockImplementation(() => Promise.resolve(response(snapshot)));

    await fetchPostingQueueSnapshot("UTC");
    await fetchPostingQueueSnapshot("America/New_York");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("clears a completed request instead of caching stale data", async () => {
    const fetchMock = vi
      .mocked(fetch)
      .mockImplementation(() => Promise.resolve(response(snapshot)));

    await fetchPostingQueueSnapshot("UTC");
    await fetchPostingQueueSnapshot("UTC");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("does not retain a failed request", async () => {
    const fetchMock = vi
      .mocked(fetch)
      .mockResolvedValueOnce(response({ ok: false, error: "temporary failure" }, 500))
      .mockResolvedValueOnce(response(snapshot));

    await expect(fetchPostingQueueSnapshot("Asia/Tokyo")).rejects.toThrow(
      "temporary failure",
    );
    await expect(fetchPostingQueueSnapshot("Asia/Tokyo")).resolves.toMatchObject({
      timeVariationEnabled: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("can bypass an older in-flight request after a mutation", async () => {
    let resolveFirst!: (value: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchMock = vi
      .mocked(fetch)
      .mockReturnValueOnce(firstResponse)
      .mockImplementationOnce(() => Promise.resolve(response(snapshot)));

    const first = fetchPostingQueueSnapshot("UTC");
    const refreshed = fetchPostingQueueSnapshot("UTC", { forceRefresh: true });

    expect(first).not.toBe(refreshed);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolveFirst(response(snapshot));
    await Promise.all([first, refreshed]);
  });
});
