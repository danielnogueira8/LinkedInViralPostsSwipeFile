import { beforeEach, describe, expect, test, vi } from "vitest";

const claimMediaQuota = vi.fn();
const settleMediaQuotaClaim = vi.fn(async () => undefined);
const getMediaPresignedUrl = vi.fn();
const mapZernioError = vi.fn(() => ({ message: "provider upload failed" }));
const fetchMock = vi.fn();

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({
    workspaceId: "workspace-1",
    raw: {},
  }),
}));

vi.mock("@/lib/media-library", () => ({
  claimMediaQuota,
  settleMediaQuotaClaim,
  ZERNIO_MEDIA_WINDOW_BYTES: 5 * 1024 * 1024 * 1024,
}));

vi.mock("@/lib/zernio", () => ({
  getMediaPresignedUrl,
  mapZernioError,
}));

vi.mock("@/lib/workspace", () => ({
  errorResponse: (error: unknown) =>
    Response.json(
      { ok: false, error: (error as Error).message ?? "internal" },
      { status: 500 },
    ),
}));

const { POST: presign } = await import("@/app/api/zernio/media/presign/route");
const { POST: upload } = await import("@/app/api/zernio/media/upload/route");

const PRESIGN = {
  uploadUrl: "https://uploads.example.test/object",
  publicUrl: "https://cdn.example.test/object",
  key: "object",
  expiresIn: 900,
};

function presignRequest() {
  return new Request("https://app.test/api/zernio/media/presign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      filename: "post.png",
      contentType: "image/png",
      size: 128,
    }),
  });
}

function uploadRequest() {
  const form = new FormData();
  form.set("file", new File([new Uint8Array([1, 2, 3])], "post.png", { type: "image/png" }));
  return new Request("https://app.test/api/zernio/media/upload", {
    method: "POST",
    body: form,
  });
}

beforeEach(() => {
  claimMediaQuota.mockReset();
  claimMediaQuota.mockResolvedValue({ claimId: "claim-1", usedBefore: 0 });
  settleMediaQuotaClaim.mockClear();
  getMediaPresignedUrl.mockReset();
  getMediaPresignedUrl.mockResolvedValue(PRESIGN);
  mapZernioError.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("Zernio media route quota cleanup", () => {
  test("releases the reservation when presigning fails", async () => {
    getMediaPresignedUrl.mockRejectedValueOnce(new Error("provider unavailable"));

    const response = await presign(presignRequest());

    expect(response.status).toBe(500);
    expect(settleMediaQuotaClaim).toHaveBeenCalledWith(
      "workspace-1",
      "claim-1",
      "released",
    );
  });

  test("releases the reservation when fallback upload fails", async () => {
    fetchMock.mockResolvedValueOnce(new Response("provider unavailable", { status: 503 }));

    const response = await upload(uploadRequest());

    expect(response.status).toBe(502);
    expect(settleMediaQuotaClaim).toHaveBeenCalledWith(
      "workspace-1",
      "claim-1",
      "released",
    );
  });
});
