import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractUrnFromUrl,
  isLinkedInShortLink,
  resolveLinkedInShortLink,
} from "@/lib/linkedin-url";

// ---------------------------------------------------------------------------
// lnkd.in expansion.
//
// The share sheet hands out https://lnkd.in/p/<code>, which carries no
// activity id — so every save path rejected it as unreadable even though it
// points at an ordinary post.
//
// Expanding it means the SERVER fetches a URL the user pasted, and ANYONE can
// mint an lnkd.in link pointing anywhere. That makes this an SSRF sink, so the
// redirect walk is the part under test.
// ---------------------------------------------------------------------------

const POST_URL =
  "https://www.linkedin.com/posts/byrongrealy_linkedin-will-now-let-you-report-a-post-as-share-7491388174175203328-aWuu/?utm_source=share";

function redirectTo(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

describe("shortlink detection", () => {
  it("recognizes LinkedIn's shortener over https", () => {
    expect(isLinkedInShortLink("https://lnkd.in/p/er5maq3G")).toBe(true);
    expect(isLinkedInShortLink("https://www.lnkd.in/p/er5maq3G")).toBe(true);
  });

  it("rejects lookalikes and plain http", () => {
    expect(isLinkedInShortLink("http://lnkd.in/p/er5maq3G")).toBe(false);
    expect(isLinkedInShortLink("https://lnkd.in.evil.com/p/x")).toBe(false);
    expect(isLinkedInShortLink("https://evil.com/lnkd.in/p/x")).toBe(false);
    expect(isLinkedInShortLink("https://notlnkd.in/p/x")).toBe(false);
  });

  it("rejects non-shortlinks and junk", () => {
    expect(isLinkedInShortLink(POST_URL)).toBe(false);
    expect(isLinkedInShortLink(null)).toBe(false);
    expect(isLinkedInShortLink("")).toBe(false);
    expect(isLinkedInShortLink("not a url")).toBe(false);
  });
});

describe("shortlink expansion", () => {
  afterEach(() => vi.restoreAllMocks());

  it("expands to the post URL the user actually meant", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(redirectTo(POST_URL));
    const resolved = await resolveLinkedInShortLink("https://lnkd.in/p/er5maq3G");
    expect(resolved).toBeTruthy();
    // And the whole point: the expansion is now parseable by the save path.
    expect(extractUrnFromUrl(resolved!)?.id).toBe("7491388174175203328");
  });

  it("never follows a redirect off LinkedIn", async () => {
    // Anyone can mint a shortlink. Following this would hand an attacker a
    // request to the cloud metadata endpoint from our server.
    for (const target of [
      "http://169.254.169.254/latest/meta-data/",
      "https://evil.com/",
      "http://localhost/admin",
      "file:///etc/passwd",
    ]) {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(redirectTo(target));
      await expect(
        resolveLinkedInShortLink("https://lnkd.in/p/er5maq3G"),
      ).resolves.toBeNull();
      // One request — to lnkd.in — and the walk stopped there.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toContain("lnkd.in");
      fetchMock.mockRestore();
    }
  });

  it("asks the runtime not to follow redirects for us", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(redirectTo(POST_URL));
    await resolveLinkedInShortLink("https://lnkd.in/p/er5maq3G");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it("follows a shortlink that chains through another shortlink", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(redirectTo("https://lnkd.in/p/second"))
      .mockResolvedValueOnce(redirectTo(POST_URL));
    await expect(
      resolveLinkedInShortLink("https://lnkd.in/p/first"),
    ).resolves.toContain("linkedin.com/posts/");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up on a redirect loop instead of spinning", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(redirectTo("https://lnkd.in/p/loop"));
    await expect(
      resolveLinkedInShortLink("https://lnkd.in/p/loop"),
    ).resolves.toBeNull();
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("returns null when lnkd.in serves an interstitial instead of a redirect", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>leaving LinkedIn</html>", { status: 200 }),
    );
    await expect(
      resolveLinkedInShortLink("https://lnkd.in/p/er5maq3G"),
    ).resolves.toBeNull();
  });

  it("fails soft on a network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("timeout"));
    await expect(
      resolveLinkedInShortLink("https://lnkd.in/p/er5maq3G"),
    ).resolves.toBeNull();
  });

  it("never fetches for a URL that is not a shortlink", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(resolveLinkedInShortLink(POST_URL)).resolves.toBeNull();
    await expect(
      resolveLinkedInShortLink("https://evil.com/p/x"),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves a relative Location against the shortlink host", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(redirectTo("/p/relative"));
    // Relative to lnkd.in, so it is another shortlink hop, not a LinkedIn URL.
    // The walk continues rather than mistaking it for a post.
    await expect(
      resolveLinkedInShortLink("https://lnkd.in/p/er5maq3G"),
    ).resolves.toBeNull();
  });
});
