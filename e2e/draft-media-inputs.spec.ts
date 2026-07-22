import { expect, test } from "@playwright/test";

test.describe("draft editor media inputs", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/zernio/media/presign", async (route) => {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, uploadUrl: "https://upload.test/media", publicUrl: "https://media.zernio.com/media", key: "media" }) });
    });
    await page.route("https://upload.test/**", async (route) => route.fulfill({ status: 200 }));
    await page.route("**/api/zernio/media/upload", async (route) => {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, publicUrl: "https://media.zernio.com/media", key: "media" }) });
    });
    await page.goto("/dashboard/posts");
    await page.getByRole("button", { name: "New post" }).click();
  });

  test("pastes and drops images through the existing uploader without duplicate uploads", async ({ page }) => {
    const editor = page.getByLabel("Post body");
    await dispatchFile(editor, "paste", "pasted.png", "image/png");
    await expect(page.getByText("pasted.png")).toBeVisible();

    await dispatchFile(editor, "drop", "dropped.png", "image/png");
    await expect(page.getByText("dropped.png")).toBeVisible();
  });

  test("keeps pasted text as text and rejects unsupported image files", async ({ page }) => {
    const editor = page.getByLabel("Post body");
    await editor.fill("Pasted text stays in the draft.");
    await dispatchFile(editor, "paste", "unsupported.svg", "image/svg+xml");
    await expect(page.getByText(/Unsupported media type/)).toBeVisible();
    await expect(editor).toHaveValue("Pasted text stays in the draft.");
  });

  test("shows the existing upload error when preparation fails", async ({ page }) => {
    await page.unroute("**/api/zernio/media/presign");
    await page.route("**/api/zernio/media/presign", async (route) => {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: false, error: "Upload preparation failed." }) });
    });
    await dispatchFile(page.getByLabel("Post body"), "drop", "failed.png", "image/png");
    await expect(page.getByText("Upload preparation failed.")).toBeVisible();
  });
});

async function dispatchFile(
  locator: import("@playwright/test").Locator,
  type: "paste" | "drop",
  name: string,
  mimeType: string,
) {
  await locator.evaluate((element, event) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["image"], event.name, { type: event.mimeType }));
    element.dispatchEvent(
      event.type === "paste"
        ? new ClipboardEvent("paste", { bubbles: true, clipboardData: transfer })
        : new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  }, { type, name, mimeType });
}
