import { describe, expect, test } from "vitest";
import { readUploadError, UPLOAD_BODY_LIMIT_BYTES } from "@/lib/upload-media-asset";
import { IMAGE_ACCEPT_ATTR, validatePostMediaFile } from "@/lib/post-media";

// ---------------------------------------------------------------------------
// The reported bug: uploading a photo in Cowork produced
//
//     Unexpected token 'R', "Request En"... is not valid JSON
//
// That is the string "Request Entity Too Large" — a plain-text 413 from the
// platform's request-body limit — being fed to res.json(). The upload code
// parsed the body without ever checking res.ok, so a perfectly clear server
// error was destroyed and replaced with a parse error.
// ---------------------------------------------------------------------------

const res = (body: string, init: ResponseInit) => new Response(body, init);

describe("readUploadError never throws on a non-JSON body", () => {
  test("a plain-text 413 becomes a size message, not a JSON parse error", async () => {
    const msg = await readUploadError(
      res("Request Entity Too Large", { status: 413, statusText: "Payload Too Large" }),
    );
    expect(msg).toMatch(/too large/i);
    expect(msg).not.toMatch(/JSON/i);
    // and it tells the user the actual limit
    expect(msg).toMatch(/4\.5 MB/);
  });

  test("an HTML error page does not leak markup into the message", async () => {
    const msg = await readUploadError(
      res("<!doctype html><html><body>502 Bad Gateway</body></html>", {
        status: 502,
        statusText: "Bad Gateway",
      }),
    );
    expect(msg).not.toContain("<");
    expect(msg).toContain("502");
  });

  test("a JSON error body still surfaces its message", async () => {
    const msg = await readUploadError(
      res(JSON.stringify({ error: "Unsupported file type." }), { status: 400 }),
    );
    expect(msg).toBe("Unsupported file type.");
  });

  test("an empty body falls back to the status, never to a crash", async () => {
    const msg = await readUploadError(res("", { status: 500, statusText: "Server Error" }));
    expect(msg).toContain("500");
  });

  test("a long plain-text body is truncated so a whole page can't land in a toast", async () => {
    const msg = await readUploadError(res("x".repeat(5000), { status: 400 }));
    expect(msg.length).toBeLessThanOrEqual(140);
  });
});

describe("image type coverage", () => {
  const accepts = (contentType: string) =>
    validatePostMediaFile({ name: "p.img", contentType, size: 1000 });

  test("accepts the formats phones and design tools actually produce", () => {
    for (const mime of [
      "image/jpeg",
      "image/jpg", // non-standard but very common
      "image/png",
      "image/gif",
      "image/webp",
      "image/heic", // iPhone camera default
      "image/heif",
      "image/avif",
      "image/bmp",
      "image/tiff",
    ]) {
      const r = accepts(mime);
      expect(r.ok, `${mime} should be accepted`).toBe(true);
    }
  });

  test("still rejects SVG — it is executable, and a stored-XSS surface", () => {
    expect(accepts("image/svg+xml").ok).toBe(false);
  });

  test("the picker's accept attribute is derived from the validator's set", () => {
    // These drifting apart is what makes a widened validator do nothing: the
    // file dialog would still refuse to show the file.
    for (const mime of ["image/heic", "image/avif", "image/jpg"]) {
      expect(IMAGE_ACCEPT_ATTR).toContain(mime);
    }
    expect(IMAGE_ACCEPT_ATTR).not.toContain("svg");
  });
});

describe("the platform body limit", () => {
  test("is below Vercel's 4.5 MB serverless request cap", () => {
    expect(UPLOAD_BODY_LIMIT_BYTES).toBeLessThanOrEqual(4.5 * 1024 * 1024);
  });
});
