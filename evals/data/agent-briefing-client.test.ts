import { beforeEach, describe, expect, test, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { loadAgentBriefing } = await import(
  "@/app/(app)/dashboard/agent-briefing-client"
);

beforeEach(() => {
  fetchMock.mockReset();
});

describe("loadAgentBriefing", () => {
  test("shares an in-flight request between the page and navigation badge", async () => {
    type MockResponse = { json: () => Promise<unknown> };
    let releaseResponse!: (value: MockResponse) => void;
    const response = new Promise<MockResponse>((resolve) => {
      releaseResponse = resolve;
    });
    fetchMock.mockReturnValue(response);

    const pageRequest = loadAgentBriefing();
    const badgeRequest = loadAgentBriefing();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pageRequest).toBe(badgeRequest);

    releaseResponse({
      json: async () => ({ ok: true, drafts: [], opportunities: [] }),
    });
    await expect(pageRequest).resolves.toMatchObject({ ok: true });
  });
});
