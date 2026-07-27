import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import {
  PerformanceTrendCard,
  PostPerformanceSection,
} from "@/app/(app)/dashboard/analytics/view";

describe("analytics performance trend controls", () => {
  test("renders every selectable metric with impressions selected by default", () => {
    const html = renderToStaticMarkup(
      createElement(PerformanceTrendCard, {
        trend: [
          {
            date: "2026-07-26",
            impressions: 10,
            engagements: 2,
            engagementRate: 20,
            comments: 1,
            savesAndShares: 1,
          },
          {
            date: "2026-07-27",
            impressions: 20,
            engagements: 5,
            engagementRate: 25,
            comments: 2,
            savesAndShares: 2,
          },
        ],
      }),
    );

    expect(html).toContain("Performance trend");
    expect(html).toContain('role="group" aria-label="Chart metric"');
    for (const label of [
      "Impressions",
      "Engagements",
      "Engagement rate",
      "Comments",
      "Saves + shares",
    ]) {
      expect(html).toContain(`>${label}</button>`);
    }
    expect(html).toMatch(
      /aria-pressed="true"[^>]*>Impressions<\/button>/,
    );
    expect(html).toContain(
      "Percentage of impressions that resulted in an interaction.",
    );
    expect(html).toMatch(
      /aria-describedby="analytics-trend-engagement-rate-help"/,
    );
  });

  test("keeps the overview stable while daily history is still sparse", () => {
    const html = renderToStaticMarkup(
      createElement(PerformanceTrendCard, { trend: [] }),
    );
    expect(html).toContain("Not enough daily changes yet");
    expect(html).toContain("At least two measured days");
  });

  test("uses the selected metric's availability for the sparse state", () => {
    const html = renderToStaticMarkup(
      createElement(PerformanceTrendCard, {
        trend: [
          {
            date: "2026-07-26",
            impressions: null,
            engagements: 2,
            engagementRate: null,
            comments: 2,
            savesAndShares: null,
          },
          {
            date: "2026-07-27",
            impressions: null,
            engagements: 1,
            engagementRate: null,
            comments: 1,
            savesAndShares: null,
          },
        ],
      }),
    );
    expect(html).toContain("Not enough daily changes yet");
    expect(html).not.toContain('aria-label="2026-07-26: 0 impressions"');
  });
});

describe("analytics post performance", () => {
  test("renders sortable controls, responsive views, and exact-post links", () => {
    const html = renderToStaticMarkup(
      createElement(PostPerformanceSection, {
        period: "30d",
        posts: [
          {
            artifactId: "draft/with spaces",
            title: "A useful post",
            publishedAt: "2026-07-27T10:00:00Z",
            contentType: "lead_magnet",
            impressions: 1_000,
            reach: 800,
            likes: 50,
            comments: 20,
            shares: 5,
            saves: 10,
            sends: 5,
          },
        ],
      }),
    );

    expect(html).toContain("Post performance");
    expect(html).toContain('type="search"');
    expect(html).toContain("Most recent");
    expect(html).toContain("Engagement rate");
    expect(html).toContain("Saves + shares");
    expect(html).toContain(
      "Includes reactions, comments, shares, saves, and sends.",
    );
    expect(html).toContain('role="tooltip"');
    expect(html).toContain("md:block");
    expect(html).toContain("md:hidden");
    expect(html).toContain(
      'href="/dashboard/posts?open=draft%2Fwith%20spaces"',
    );
    expect(html).toContain("Lead magnet");
  });
});
