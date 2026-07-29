import { expect, test } from "@playwright/test";

test("Memory Rules scroll independently from the Voice page", async ({
  page,
}) => {
  await page.goto("/dashboard/voice");
  await expect(
    page.getByRole("heading", { name: "Voice", exact: true }),
  ).toBeVisible();

  const createdIds: string[] = [];
  const marker = `e2e-scroll-${Date.now()}`;
  try {
    for (let index = 0; index < 6; index += 1) {
      const response = await page.request.post("/api/preferences", {
        data: {
          rule: `${marker} rule ${index}`,
          detail: `${marker} context ${index} `.repeat(20),
        },
      });
      expect(response.ok()).toBe(true);
      const payload = (await response.json()) as {
        preference?: { id?: string };
      };
      expect(payload.preference?.id).toBeTruthy();
      createdIds.push(payload.preference!.id!);
    }

    await page.reload();
    const list = page.getByTestId("memory-rules-scroll");
    await expect(list).toBeVisible();
    const pageTopBefore = await page.evaluate(() => window.scrollY);
    const metrics = await list.evaluate((element) => ({
      clientHeight: element.clientHeight,
      overflowY: getComputedStyle(element).overflowY,
      scrollHeight: element.scrollHeight,
    }));

    expect(metrics.overflowY).toBe("auto");
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    await list.evaluate((element) =>
      element.scrollTo({ top: element.scrollHeight }),
    );
    await expect
      .poll(() => list.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(pageTopBefore);
  } finally {
    await Promise.all(
      createdIds.map((id) => page.request.delete(`/api/preferences/${id}`)),
    );
  }
});
