import { expect, test } from "@playwright/test";
import { SWIPE_FILE_APP_HTML } from "../../lib/mcp/swipe-file-app.generated";

const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const RESULT = {
  structuredContent: {
    ok: true,
    count: 1,
    posts: [
      {
        id: "post-1",
        text: "First line.\n\nSecond paragraph.",
        post_url: "https://www.linkedin.com/posts/example",
        posted_at: "2026-07-22T00:00:00.000Z",
        reactions: 2_673,
        comments: 1_636,
        reposts: 238,
        media_type: "image",
        media_urls: ["https://media-exp1.licdn.com/post.png"],
        post_type: "regular",
        accounts: {
          name: "Jasmin Alic",
          niche: "Leadership",
          profile_pic_url: "https://media-exp1.licdn.com/avatar.png",
        },
      },
    ],
  },
  content: [],
};

test.describe("Swipe File MCP App browser rendering", () => {
  test("shows LinkedIn-style copy and media from supported LinkedIn image hosts", async ({
    page,
  }) => {
    await page.route(/https:\/\/[^/]+\.licdn\.com\/.+/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "image/png",
        body: TRANSPARENT_PNG,
      }),
    );

    await page.evaluate((html) => {
      const iframe = document.createElement("iframe");
      iframe.id = "mcp-app";
      iframe.srcdoc = html;
      document.body.append(iframe);
    }, SWIPE_FILE_APP_HTML);

    const app = page.frameLocator("#mcp-app");
    await app.locator("#posts").waitFor({ state: "attached" });
    await page.evaluate((result) => {
      const iframe = document.querySelector<HTMLIFrameElement>("#mcp-app");
      iframe?.contentWindow?.postMessage(
        {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: result,
        },
        "*",
      );
    }, RESULT);

    const copy = app.locator(".copy");
    await copy.waitFor({ timeout: 2_000 });

    await expect(copy).toBeVisible();
    await expect(copy).toHaveText("First line.\n\nSecond paragraph.");
    expect(
      await copy.evaluate((element) => getComputedStyle(element).whiteSpace),
    ).toBe("pre-wrap");
    await expect(app.locator("img.media")).toBeVisible();
    await expect(app.locator("img.avatar-image")).toBeVisible();
  });
});
