import { test, expect } from "@playwright/test";

test("minimum engagement settings are readable and touch-friendly on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard/settings");

  const card = page
    .locator('[data-slot="card"]')
    .filter({ hasText: "Minimum engagement" });
  await expect(card).toBeVisible();

  const regularSwitch = page.getByRole("switch", {
    name: "Use a minimum likes threshold for regular posts",
  });
  const leadMagnetSwitch = page.getByRole("switch", {
    name: "Use a minimum comments threshold for lead magnet posts",
  });
  const save = page.getByRole("button", { name: "Save thresholds" });

  for (const control of [regularSwitch, leadMagnetSwitch]) {
    const box = await control.boundingBox();
    expect(box, "threshold switch should have a measurable hit target").not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  const initiallyChecked = await regularSwitch.getAttribute("aria-checked");
  await regularSwitch.click();
  await expect(regularSwitch).toHaveAttribute(
    "aria-checked",
    initiallyChecked === "true" ? "false" : "true",
  );
  await regularSwitch.click();

  const [cardBox, saveBox] = await Promise.all([
    card.boundingBox(),
    save.boundingBox(),
  ]);
  expect(cardBox).not.toBeNull();
  expect(saveBox).not.toBeNull();
  expect(saveBox!.width).toBeGreaterThanOrEqual(cardBox!.width * 0.9);
  await page.screenshot({
    path: "/tmp/swipein-settings-mobile.png",
    fullPage: true,
  });

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(
      hasHorizontalOverflow,
      `settings should not overflow at ${width}px`,
    ).toBe(false);
  }
});
