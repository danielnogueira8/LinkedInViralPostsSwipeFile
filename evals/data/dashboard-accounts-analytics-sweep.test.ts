import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

type AnalyticsRow = {
  artifact_id: string;
  snapshot_date: string;
  impressions: number;
  reach: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  sends: number;
  video_views: null;
  fetched_at: string;
};

type ArtifactRow = {
  id: string;
  title: string;
  body: string;
  published_at: string;
  kind: string;
};

const rows: AnalyticsRow[] = [
  {
    artifact_id: "regular-post",
    snapshot_date: "2026-08-01",
    impressions: 100,
    reach: 80,
    likes: 10,
    comments: 1,
    shares: 0,
    saves: 0,
    sends: 0,
    video_views: null,
    fetched_at: "2026-08-01T09:00:00.000Z",
  },
  {
    artifact_id: "lead-post",
    snapshot_date: "2026-08-01",
    impressions: 200,
    reach: 160,
    likes: 20,
    comments: 2,
    shares: 0,
    saves: 0,
    sends: 0,
    video_views: null,
    fetched_at: "2026-08-01T09:00:00.000Z",
  },
];

const artifacts: ArtifactRow[] = [
  {
    id: "regular-post",
    title: "Regular post",
    body: "Regular body",
    published_at: "2026-07-31T09:00:00.000Z",
    kind: "post",
  },
  {
    id: "lead-post",
    title: "Lead magnet post",
    body: "Lead magnet body",
    published_at: "2026-07-31T10:00:00.000Z",
    kind: "lead_magnet",
  },
];

let captured: { analyticsPostCount: number } | null = null;

function builderFor(table: string) {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    not: () => chain,
    in: () => chain,
    range: async () => ({
      data: table === "post_analytics" ? rows : [],
      error: null,
    }),
    then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
      Promise.resolve({
        data: table === "chat_artifacts" ? artifacts : [],
        error: null,
      }).then(resolve),
  });
  return chain;
}

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: vi.fn(async () => ({
    workspaceId: "workspace-1",
    raw: { from: builderFor },
  })),
}));

vi.mock("@/lib/publishing", () => ({
  getConnection: vi.fn(async () => ({ status: "active" })),
  canPublish: vi.fn(() => true),
}));

vi.mock("@/components/app-surface", () => ({
  PageHeader: ({ children }: { children?: unknown }) => children,
  PageShell: ({ children }: { children?: unknown }) => children,
}));

vi.mock("@/components/surface-help", () => ({
  SurfaceHelp: () => null,
}));

vi.mock("@/app/(app)/dashboard/analytics/view", () => ({
  AnalyticsView: (props: { analyticsPostCount: number }) => {
    captured = { analyticsPostCount: props.analyticsPostCount };
    return null;
  },
}));

const { default: AnalyticsPage } = await import(
  "@/app/(app)/dashboard/analytics/page"
);

beforeEach(() => {
  captured = null;
});

describe("dashboard analytics discovery sweep", () => {
  test("passes the selected content type's post count to the empty-state seam", async () => {
    const page = await AnalyticsPage({
      searchParams: Promise.resolve({ type: "lead_magnet", period: "all" }),
    });
    renderToStaticMarkup(page);

    expect(captured).toEqual({ analyticsPostCount: 1 });
  });
});
