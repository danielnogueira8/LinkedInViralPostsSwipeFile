import { expect, test, type Page } from "@playwright/test";

type AnalyticsFixture = {
  artifactId: string;
  title: string;
  endpoint: string;
  headers: Record<string, string>;
};

let fixture: AnalyticsFixture | null = null;

function isoDate(daysAgo: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

async function seedAnalytics(page: Page): Promise<AnalyticsFixture> {
  const title = `Analytics responsive fixture ${Date.now()}`;
  const created = await page.request.post("/api/drafts", {
    data: {
      title,
      body: `A deterministic analytics fixture ${crypto.randomUUID()}`,
      kind: "post",
    },
  });
  expect(created.ok()).toBe(true);
  const payload = (await created.json()) as {
    draft?: { id?: string };
  };
  const artifactId = payload.draft?.id;
  if (!artifactId) throw new Error("Analytics fixture draft was not created");

  let cleanup = async () => {
    const response = await page.request.delete(`/api/drafts/${artifactId}`);
    if (!response.ok()) {
      throw new Error(
        `Failed to remove partial analytics fixture (${response.status()})`,
      );
    }
  };
  try {
    const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!baseUrl || !serviceKey) {
      throw new Error("Supabase E2E credentials are missing");
    }
    const headers = {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      "content-type": "application/json",
    };
    const artifactQuery = new URLSearchParams({
      id: `eq.${artifactId}`,
      select: "workspace_id",
      limit: "1",
    });
    const artifactEndpoint = `${baseUrl}/rest/v1/chat_artifacts?${artifactQuery}`;
    cleanup = async () => {
      const response = await fetch(artifactEndpoint, {
        method: "DELETE",
        headers,
      });
      if (!response.ok) {
        throw new Error(
          `Failed to remove partial analytics fixture (${response.status})`,
        );
      }
    };
    const artifactResponse = await fetch(artifactEndpoint, { headers });
    if (!artifactResponse.ok) {
      throw new Error(
        `Failed to read analytics fixture (${artifactResponse.status})`,
      );
    }
    const workspaceId = (
      (await artifactResponse.json()) as Array<{ workspace_id: string }>
    )[0]?.workspace_id;
    if (!workspaceId) throw new Error("Analytics fixture has no workspace");

    const zernioPostId = `analytics-e2e-${artifactId}`;
    const published = await fetch(artifactEndpoint, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        schedule_status: "published",
        zernio_post_id: zernioPostId,
        published_at: new Date().toISOString(),
      }),
    });
    if (!published.ok) {
      throw new Error(`Failed to publish analytics fixture (${published.status})`);
    }

    const snapshots = [2, 1, 0].map((daysAgo, index) => ({
      workspace_id: workspaceId,
      artifact_id: artifactId,
      zernio_post_id: zernioPostId,
      snapshot_date: isoDate(daysAgo),
      impressions: 100 + index * 50,
      reach: 80 + index * 40,
      likes: 10 + index * 5,
      comments: 2 + index * 2,
      shares: 1 + index,
      saves: index,
      sends: index,
      fetched_at: new Date().toISOString(),
    }));
    const inserted = await fetch(`${baseUrl}/rest/v1/post_analytics`, {
      method: "POST",
      headers,
      body: JSON.stringify(snapshots),
    });
    if (!inserted.ok) {
      throw new Error(`Failed to seed analytics snapshots (${inserted.status})`);
    }
    return { artifactId, title, endpoint: artifactEndpoint, headers };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Analytics fixture setup and cleanup both failed",
      );
    }
    throw error;
  }
}

test.afterEach(async () => {
  if (!fixture) return;
  const removed = await fetch(fixture.endpoint, {
    method: "DELETE",
    headers: fixture.headers,
  });
  fixture = null;
  if (!removed.ok) {
    throw new Error(`Failed to remove analytics fixture (${removed.status})`);
  }
});

test("analytics overview stays usable on mobile and desktop", async ({ page }) => {
  fixture = await seedAnalytics(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard/analytics");
  await expect(page.getByRole("heading", { name: "Analytics" })).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Chart metric" }),
  ).toBeVisible();

  const metric = page.getByRole("button", {
    name: "Saves + shares",
    exact: true,
  });
  await metric.click();
  await expect(metric).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("What changed", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Post performance" }),
  ).toBeVisible();
  await page
    .locator(
      '[aria-describedby="analytics-summary-engagement-rate-help"]',
    )
    .focus();
  await expect(
    page.locator("#analytics-summary-engagement-rate-help"),
  ).toBeVisible();
  await expect(
    page.locator("#analytics-summary-engagement-rate-help"),
  ).toContainText("Percentage of impressions");

  const search = page.getByRole("searchbox", { name: "Search posts" });
  const sort = page.getByRole("combobox", { name: "Sort posts" });
  await sort.selectOption("engagementRate");
  await expect(sort).toHaveValue("engagementRate");
  await search.fill("no matching analytics fixture");
  await expect(page.getByText("No matching posts")).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  const exactPostHref = `/dashboard/posts?open=${encodeURIComponent(
    fixture.artifactId,
  )}`;
  const exactPostLink = page
    .locator(`a[href="${exactPostHref}"]:visible`)
    .first();
  await expect(exactPostLink).toBeVisible();
  await exactPostLink.click();
  await expect(
    page.getByText("Edit post", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Preview name" })).toHaveValue(
    fixture.title,
  );
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Post performance" }),
  ).toBeVisible();

  const chart = page
    .getByRole("heading", { name: "Performance trend" })
    .locator("xpath=ancestor::section");
  const insight = page.locator("aside").filter({ hasText: "What changed" });

  for (const width of [390, 320, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    const hasHorizontalOverflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    );
    expect(
      hasHorizontalOverflow,
      `analytics should not overflow at ${width}px`,
    ).toBe(false);

    if (width < 768) {
      await expect(
        page.locator(`a[href="${exactPostHref}"]:visible`).first(),
      ).toBeVisible();
      await page
        .locator(
          '[aria-describedby="post-performance-mobile-engagement-rate-help-0"]',
        )
        .focus();
      await expect(
        page.locator("#post-performance-mobile-engagement-rate-help-0"),
      ).toBeVisible();
    } else {
      await page
        .locator(
          '[aria-describedby="post-performance-table-engagement-rate-help"]',
        )
        .focus();
      await expect(
        page.locator("#post-performance-table-engagement-rate-help"),
      ).toBeVisible();
    }

    const [chartBox, insightBox] = await Promise.all([
      chart.boundingBox(),
      insight.boundingBox(),
    ]);
    expect(chartBox).not.toBeNull();
    expect(insightBox).not.toBeNull();
    if (width < 1024) {
      expect(insightBox!.y).toBeGreaterThanOrEqual(
        chartBox!.y + chartBox!.height,
      );
    } else {
      expect(Math.abs(insightBox!.y - chartBox!.y)).toBeLessThanOrEqual(2);
    }
  }

  await page.screenshot({
    path: "/tmp/swipein-analytics-overview.png",
    fullPage: true,
  });
});
