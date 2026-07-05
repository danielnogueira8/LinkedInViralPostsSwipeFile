import { describe, test, expect, vi, afterEach, beforeEach } from "vitest";
import { makeFakeSupabase, type FakeDb } from "./fake-supabase";

// ---------------------------------------------------------------------------
// The Zernio client (lib/zernio.ts) — the LinkedIn publish path. Pins:
//   • mapZernioError classifies the recurring failures correctly (422 duplicate
//     is PERMANENT, token-expiry flips the connection, 5xx is transient);
//   • createLinkedInPost builds the right body, returns the post id on success,
//     and surfaces a typed error on failure — WITHOUT retrying a 422 (that comes
//     free from fetchWithRetry, which never retries a 4xx; we assert fetch was
//     called exactly once on a 422 so a duplicate is never re-posted);
//   • logZernioUsage writes a workspace-scoped usage_events row.
// fetch is stubbed globally (fetchWithRetry calls fetch); supabaseAdmin is faked.
// ---------------------------------------------------------------------------

const dbRef: { current: FakeDb } = { current: makeFakeSupabase({}) };
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => dbRef.current.client }));

const {
  mapZernioError,
  createLinkedInPost,
  logZernioUsage,
  LINKEDIN_MAX_CHARS,
} = await import("@/lib/zernio");

beforeEach(() => {
  dbRef.current = makeFakeSupabase({});
  process.env.ZERNIO_API_KEY = "test-key";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetchOnce(res: {
  ok: boolean;
  status?: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}) {
  const fn = vi.fn(
    (): Promise<Response> =>
      Promise.resolve({
        ok: res.ok,
        status: res.status ?? (res.ok ? 200 : 500),
        statusText: "",
        headers: { get: () => null },
        json: res.json ?? (async () => ({})),
        text: res.text ?? (async () => ""),
      } as unknown as Response),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

// Read the RequestInit of the Nth fetch call (mock args are untyped here).
function initOf(fn: ReturnType<typeof stubFetchOnce>, call = 0): RequestInit {
  return (fn.mock.calls[call] as unknown as [string, RequestInit])[1];
}

describe("mapZernioError — classifies the recurring failures", () => {
  test("422 (or a 'duplicate' body) → duplicate, PERMANENT", () => {
    expect(mapZernioError(422, "").kind).toBe("duplicate");
    expect(mapZernioError(400, "Content is a duplicate of urn:li:share:X").kind).toBe("duplicate");
    expect(mapZernioError(422, "").message).toMatch(/duplicate/i);
  });

  test("401 / token-expiry body → token_expired (reconnect)", () => {
    expect(mapZernioError(401, "").kind).toBe("token_expired");
    expect(mapZernioError(403, "OAuth token expired").kind).toBe("token_expired");
    expect(mapZernioError(403, "token revoked").kind).toBe("token_expired");
  });

  test("'preflight' body → preflight", () => {
    expect(mapZernioError(400, "Publishing failed during preflight checks").kind).toBe("preflight");
  });

  test("'max retries' body → transient", () => {
    expect(mapZernioError(500, "Publishing failed due to max retries reached").kind).toBe("transient");
  });

  test("a bare 5xx → transient; a bare non-duplicate 4xx → other", () => {
    expect(mapZernioError(503, "").kind).toBe("transient");
    expect(mapZernioError(418, "").kind).toBe("other");
  });
});

describe("createLinkedInPost", () => {
  test("success → { ok:true, postId } and posts a well-formed LinkedIn body", async () => {
    const fetchFn = stubFetchOnce({
      ok: true,
      json: async () => ({ post: { _id: "post-123" } }),
    });
    const out = await createLinkedInPost({ accountId: "acct-1", content: "hello world" });
    expect(out).toEqual({ ok: true, postId: "post-123" });
    // Body shape: linkedin platform, the accountId, publishNow.
    const body = JSON.parse(initOf(fetchFn).body as string);
    expect(body.publishNow).toBe(true);
    expect(body.content).toBe("hello world");
    expect(body.platforms[0]).toMatchObject({ platform: "linkedin", accountId: "acct-1" });
    // No first-comment → no platformSpecificData key.
    expect(body.platforms[0].platformSpecificData).toBeUndefined();
    // Bearer auth from the env key.
    expect(initOf(fetchFn).headers).toMatchObject({
      Authorization: "Bearer test-key",
    });
  });

  test("firstComment rides in platformSpecificData", async () => {
    const fetchFn = stubFetchOnce({ ok: true, json: async () => ({ post: { _id: "p" } }) });
    await createLinkedInPost({ accountId: "a", content: "c", firstComment: "link: https://x.com" });
    const body = JSON.parse(initOf(fetchFn).body as string);
    expect(body.platforms[0].platformSpecificData.firstComment).toBe("link: https://x.com");
  });

  test("mediaItems ride at the post root", async () => {
    const fetchFn = stubFetchOnce({ ok: true, json: async () => ({ post: { _id: "p" } }) });
    await createLinkedInPost({
      accountId: "a",
      content: "c",
      mediaItems: [{ url: "https://media.zernio.com/x/photo.jpg", type: "image" }],
    });
    const body = JSON.parse(initOf(fetchFn).body as string);
    expect(body.mediaItems).toEqual([{ url: "https://media.zernio.com/x/photo.jpg", type: "image" }]);
  });

  test("a 422 duplicate → typed error AND fetch called exactly once (never re-posts)", async () => {
    const fetchFn = stubFetchOnce({
      ok: false,
      status: 422,
      text: async () => "Content is a duplicate of urn:li:share:999",
    });
    const out = await createLinkedInPost({ accountId: "a", content: "dupe" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.kind).toBe("duplicate");
    // The crux: fetchWithRetry must NOT retry a 4xx — one attempt only.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test("a token-expiry 401 → token_expired error", async () => {
    stubFetchOnce({ ok: false, status: 401, text: async () => "token expired" });
    const out = await createLinkedInPost({ accountId: "a", content: "c" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.kind).toBe("token_expired");
  });

  test("missing ZERNIO_API_KEY → surfaced, not a crash", async () => {
    delete process.env.ZERNIO_API_KEY;
    // apiKey() throws synchronously inside the try → caught → transient error.
    const out = await createLinkedInPost({ accountId: "a", content: "c" });
    expect(out.ok).toBe(false);
  });
});

describe("logZernioUsage — workspace-scoped usage row", () => {
  test("inserts a zernio usage_events row for the workspace", async () => {
    await logZernioUsage("linkedin_publish", "ws-1", { artifact_id: "d1" });
    const ins = dbRef.current.queries
      .filter((q) => q.table === "usage_events")
      .flatMap((q) => q.filters.filter((f) => f.method === "insert").map((f) => f.args[0] as Record<string, unknown>))[0];
    expect(ins.provider).toBe("zernio");
    expect(ins.workspace_id).toBe("ws-1");
    expect(ins.kind).toBe("linkedin_publish");
  });

  test("a DB throw is swallowed (never breaks a publish)", async () => {
    dbRef.current = makeFakeSupabase({ usage_events: { error: { message: "boom" } } });
    await expect(logZernioUsage("k", "ws", undefined)).resolves.toBeUndefined();
  });
});

describe("LINKEDIN_MAX_CHARS", () => {
  test("is LinkedIn's 3,000-char cap (below the 3,200 draft cap — callers must trim)", () => {
    expect(LINKEDIN_MAX_CHARS).toBe(3000);
  });
});
