import { beforeEach, describe, expect, test, vi } from "vitest";

const getMediaPresignedUrl = vi.fn(async () => ({
  uploadUrl: "https://uploads.example.test/object",
  publicUrl: "https://cdn.example.test/object",
  key: "object",
  expiresIn: 900,
}));
const claimMediaQuota = vi.fn(async () => ({ claimId: "claim-1", usedBefore: 0 }));
const workspaceState: { available: boolean } = { available: false };

vi.mock("@/lib/supabase-scoped", async () => {
  const { NoWorkspaceError } = await import("@/lib/workspace");
  return {
    scopedSupabase: async () => {
      if (!workspaceState.available) throw new NoWorkspaceError();
      return { workspaceId: "workspace-1", raw: {} };
    },
  };
});

vi.mock("@/lib/media-library", () => ({
  claimMediaQuota,
  ZERNIO_MEDIA_WINDOW_BYTES: 5 * 1024 * 1024 * 1024,
}));

vi.mock("@/lib/zernio", () => ({
  getMediaPresignedUrl,
  mapZernioError: () => ({ message: "provider upload failed" }),
}));

const { POST: presign } = await import("@/app/api/zernio/media/presign/route");
const { POST: upload } = await import("@/app/api/zernio/media/upload/route");

beforeEach(() => {
  workspaceState.available = false;
  getMediaPresignedUrl.mockClear();
  claimMediaQuota.mockClear();
  claimMediaQuota.mockResolvedValue({ claimId: "claim-1", usedBefore: 0 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 200 })),
  );
});

describe("Zernio media routes require an active workspace", () => {
  test("presign rejects before allocating provider capacity", async () => {
    const response = await presign(
      new Request("http://test/api/zernio/media/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: "post.png",
          contentType: "image/png",
          size: 128,
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(getMediaPresignedUrl).not.toHaveBeenCalled();
  });

  test("fallback upload rejects before allocating provider capacity", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1, 2, 3])], "post.png", { type: "image/png" }));

    const response = await upload(
      new Request("http://test/api/zernio/media/upload", {
        method: "POST",
        body: form,
      }),
    );

    expect(response.status).toBe(400);
    expect(getMediaPresignedUrl).not.toHaveBeenCalled();
  });

  test.each([
    ["presign", async () =>
      presign(
        new Request("http://test/api/zernio/media/presign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: "post.png", contentType: "image/png", size: 128 }),
        }),
      )],
    ["fallback upload", async () => {
      const form = new FormData();
      form.set("file", new File([new Uint8Array([1, 2, 3])], "post.png", { type: "image/png" }));
      return upload(new Request("http://test/api/zernio/media/upload", { method: "POST", body: form }));
    }],
  ])("%s enforces the workspace provider-capacity window", async (_label, request) => {
    workspaceState.available = true;
    claimMediaQuota.mockResolvedValue(null);

    const response = await request();

    expect(response.status, JSON.stringify(await response.clone().json())).toBe(429);
    expect(getMediaPresignedUrl).not.toHaveBeenCalled();
  });
});
