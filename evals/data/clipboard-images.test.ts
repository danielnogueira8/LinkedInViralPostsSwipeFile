import { describe, expect, test } from "vitest";
import { clipboardHasText, clipboardImageFiles } from "@/lib/clipboard-images";

function file(name: string, type: string, lastModified = 1) {
  return new File([new Uint8Array([1, 2, 3])], name, { type, lastModified });
}

describe("clipboardImageFiles", () => {
  test("turns an unnamed screenshot clipboard item into a sensibly named image file", () => {
    const screenshot = file("", "image/png", 42);
    const files = clipboardImageFiles({
      items: [
        {
          kind: "file",
          type: "image/png",
          getAsFile: () => screenshot,
        },
      ],
    });

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ name: "clipboard-image.png", type: "image/png" });
  });

  test("uses an image item's MIME type when the browser file omits it", () => {
    const browserCopy = file("browser-copy.png", "", 77);
    const [normalized] = clipboardImageFiles({
      items: [{ kind: "file", type: "image/png", getAsFile: () => browserCopy }],
    });
    expect(normalized).toMatchObject({ name: "browser-copy.png", type: "image/png" });
  });

  test("uses clipboard items for browser screenshots and falls back to clipboard files", () => {
    const screenshot = file("screenshot.png", "image/png");
    const fallback = file("browser-copy.webp", "image/webp");
    expect(
      clipboardImageFiles({
        items: [{ kind: "file", type: "image/png", getAsFile: () => screenshot }],
        files: [fallback],
      }).map((item) => item.name),
    ).toEqual(["screenshot.png"]);
    expect(clipboardImageFiles({ files: [fallback] }).map((item) => item.name)).toEqual([
      "browser-copy.webp",
    ]);
  });

  test("does not turn URLs, text, or duplicate clipboard entries into image uploads", () => {
    const copiedImage = file("image.png", "image/png", 99);
    const files = clipboardImageFiles({
      items: [
        { kind: "string", type: "text/plain", getAsFile: () => null },
        { kind: "file", type: "image/png", getAsFile: () => copiedImage },
        { kind: "file", type: "image/png", getAsFile: () => copiedImage },
      ],
    });
    expect(files).toHaveLength(1);
    expect(clipboardImageFiles({ items: [{ kind: "string", type: "text/uri-list", getAsFile: () => null }] })).toEqual([]);
  });

  test("recognizes text content so the editor can preserve a mixed text-and-image paste", () => {
    expect(clipboardHasText({ types: ["text/plain", "image/png"] })).toBe(true);
    expect(
      clipboardHasText({
        items: [{ kind: "string", type: "text/plain", getAsFile: () => null }],
      }),
    ).toBe(true);
    expect(clipboardHasText({ types: ["text/uri-list", "image/png"] })).toBe(false);
  });
});
