import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let postError: unknown = null;

const raw = {
  from: vi.fn(() => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      maybeSingle: async () => ({
        data: {
          id: "post-1",
          account_id: "account-1",
          document_manifest_url: "https://licdn.example.test/master.json",
          media_urls: [],
        },
        error: postError,
      }),
    });
    return chain;
  }),
};

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({ workspaceId: "workspace-1", raw }),
  trackedAccountIds: vi.fn(async () => ["account-1"]),
}));
vi.mock("@/lib/workspace", () => ({
  errorResponse: vi.fn(() => Response.json({ ok: false, error: "internal" }, { status: 500 })),
}));

const { GET } = await import("@/app/api/post-document/route");

beforeEach(() => {
  postError = null;
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("upstream unavailable");
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("GET /api/post-document fetch cleanup", () => {
  test("clears the manifest timeout when the upstream fetch rejects", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    const response = await GET(
      new Request("https://app.test/api/post-document?id=post-1"),
    );

    expect(response.status).toBe(200);
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  test("returns an internal error envelope when the post lookup fails", async () => {
    postError = new Error("database unavailable");

    const response = await GET(
      new Request("https://app.test/api/post-document?id=post-1"),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "internal" });
  });

  test("returns only pages with http or https schemes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(
          Response.json({
            perResolutions: [
              { width: 800, imageManifestUrl: "https://licdn.example.test/images.json" },
            ],
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            pages: [
              "https://cdn.example.test/page-1.jpg",
              "httpx://not-http.example.test/page-2.jpg",
              "javascript:alert(1)",
              "not a URL",
            ],
          }),
        ),
    );

    const response = await GET(
      new Request("https://app.test/api/post-document?id=post-1"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      pages: ["https://cdn.example.test/page-1.jpg"],
    });
  });
});
