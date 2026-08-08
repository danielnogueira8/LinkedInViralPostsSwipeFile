import { afterEach, describe, expect, test, vi } from "vitest";
import {
  AVATAR_MAX_BYTES,
  avatarStoragePath,
  isMirrorableAvatarUrl,
  mirrorAvatarToStorage,
} from "@/lib/avatar-mirror";

const uploadMock = vi.fn();
const getPublicUrlMock = vi.fn();

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({
    storage: {
      from: () => ({
        upload: uploadMock,
        getPublicUrl: getPublicUrlMock,
      }),
    },
  }),
}));

function imageResponse(bytes: Uint8Array, contentType = "image/jpeg") {
  return new Response(new Blob([bytes.buffer as ArrayBuffer]), {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-length": String(bytes.byteLength),
    },
  });
}

describe("avatar mirror", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    uploadMock.mockReset();
    getPublicUrlMock.mockReset();
  });

  // The URL comes from a scraper and the SERVER fetches it, so this is an SSRF
  // sink. These are the cases that must never reach fetch().
  describe("source allowlist", () => {
    test("accepts LinkedIn CDN hosts over https", () => {
      expect(isMirrorableAvatarUrl("https://media.licdn.com/dms/image/x/photo.jpg")).toBe(true);
      expect(isMirrorableAvatarUrl("https://static.licdn.com/a/photo.png")).toBe(true);
      expect(isMirrorableAvatarUrl("https://some-shard.licdn.com/photo.jpg")).toBe(true);
    });

    test("rejects internal and metadata targets", () => {
      expect(isMirrorableAvatarUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
      expect(isMirrorableAvatarUrl("https://localhost/admin")).toBe(false);
      expect(isMirrorableAvatarUrl("http://10.0.0.1/")).toBe(false);
      expect(isMirrorableAvatarUrl("file:///etc/passwd")).toBe(false);
    });

    test("rejects hosts that merely embed an allowed name", () => {
      // The reason the check parses the URL instead of substring-matching it.
      expect(isMirrorableAvatarUrl("https://evil.com/media.licdn.com/photo.jpg")).toBe(false);
      expect(isMirrorableAvatarUrl("https://media.licdn.com.evil.com/photo.jpg")).toBe(false);
      expect(isMirrorableAvatarUrl("https://notlicdn.com/photo.jpg")).toBe(false);
    });

    test("rejects plain http on an otherwise allowed host", () => {
      expect(isMirrorableAvatarUrl("http://media.licdn.com/photo.jpg")).toBe(false);
    });

    test("rejects empty and malformed input", () => {
      expect(isMirrorableAvatarUrl(null)).toBe(false);
      expect(isMirrorableAvatarUrl(undefined)).toBe(false);
      expect(isMirrorableAvatarUrl("")).toBe(false);
      expect(isMirrorableAvatarUrl("not a url")).toBe(false);
    });
  });

  test("never fetches a disallowed host", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const result = await mirrorAvatarToStorage(
      "http://169.254.169.254/latest/meta-data/",
      "ws_1",
    );
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("mirrors a real image and returns a durable public URL", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      imageResponse(new Uint8Array([1, 2, 3, 4])),
    );
    uploadMock.mockResolvedValue({ error: null });
    getPublicUrlMock.mockReturnValue({
      data: { publicUrl: "https://cdn.example.com/profile-avatars/ws_1/avatar.jpg" },
    });

    const result = await mirrorAvatarToStorage(
      "https://media.licdn.com/dms/image/x/photo.jpg",
      "ws_1",
    );

    expect(uploadMock).toHaveBeenCalledWith(
      "ws_1/avatar.jpg",
      expect.any(Uint8Array),
      expect.objectContaining({ contentType: "image/jpeg", upsert: true }),
    );
    // Public, not signed — a signed URL would reintroduce the expiry this
    // whole module exists to remove.
    expect(result).toContain("https://cdn.example.com/profile-avatars/ws_1/avatar.jpg");
    expect(result).not.toContain("token=");
  });

  test("rejects a response that is not an image", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>error</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    const result = await mirrorAvatarToStorage(
      "https://media.licdn.com/photo.jpg",
      "ws_1",
    );
    expect(result).toBeNull();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  test("rejects oversized bytes even when content-length understates them", async () => {
    const oversized = new Uint8Array(AVATAR_MAX_BYTES + 10);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Blob([oversized.buffer as ArrayBuffer]), {
        status: 200,
        // A lying header — the real bytes are what must be enforced.
        headers: { "content-type": "image/png", "content-length": "10" },
      }),
    );

    const result = await mirrorAvatarToStorage(
      "https://media.licdn.com/photo.png",
      "ws_1",
    );
    expect(result).toBeNull();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  test("fails open when the fetch throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("timeout"));
    await expect(
      mirrorAvatarToStorage("https://media.licdn.com/photo.jpg", "ws_1"),
    ).resolves.toBeNull();
  });

  test("fails open when storage rejects the upload", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      imageResponse(new Uint8Array([1, 2, 3])),
    );
    uploadMock.mockResolvedValue({ error: new Error("bucket missing") });

    await expect(
      mirrorAvatarToStorage("https://media.licdn.com/photo.jpg", "ws_1"),
    ).resolves.toBeNull();
  });

  test("keys the path by workspace so one cannot overwrite another", () => {
    expect(avatarStoragePath("ws_1", "jpg")).toBe("ws_1/avatar.jpg");
    expect(avatarStoragePath("ws_2", "jpg")).toBe("ws_2/avatar.jpg");
    // Path traversal in a workspace id must not escape the prefix.
    expect(avatarStoragePath("../../etc", "png")).toBe("______etc/avatar.png");
  });
});
