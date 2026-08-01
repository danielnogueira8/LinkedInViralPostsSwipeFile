import { beforeEach, describe, expect, test, vi } from "vitest";

describe("dashboard shell hydration and workspace cache contracts", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("usage reads are cached independently for each workspace", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, used: 2, limit: 10, boundBy: "messages" }), {
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, used: 7, limit: 20, boundBy: "cost" }), {
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { fetchUsageForWorkspace } = await import("@/app/(app)/dashboard/usage-pill");

    await expect(fetchUsageForWorkspace("workspace-a")).resolves.toEqual({
      used: 2,
      limit: 10,
      boundBy: "messages",
    });
    await expect(fetchUsageForWorkspace("workspace-b")).resolves.toEqual({
      used: 7,
      limit: 20,
      boundBy: "cost",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("LeadShark verification text is stable before hydration", async () => {
    const { verificationLabel } = await import(
      "@/app/(app)/dashboard/integrations/leadshark-card"
    );

    expect(
      verificationLabel("2026-08-01T10:00:00.000Z", false, Date.parse("2026-08-01T10:02:00.000Z")),
    ).toBe("Last verified.");
    expect(
      verificationLabel("2026-08-01T10:00:00.000Z", true, Date.parse("2026-08-01T10:02:00.000Z")),
    ).toBe("Last verified 2 minutes ago.");
  });
});
