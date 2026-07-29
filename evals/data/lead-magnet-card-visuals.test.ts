import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { LeadMagnet } from "@/lib/lead-magnets";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("next/image", () => ({
  default: (
    props: React.ImgHTMLAttributes<HTMLImageElement> & { unoptimized?: boolean },
  ) => {
    const { unoptimized, ...imageProps } = props;
    void unoptimized;
    return createElement("img", imageProps);
  },
}));

const { LeadMagnetsManager } = await import(
  "@/app/(app)/dashboard/lead-magnets/manager"
);

const LEAD_MAGNET: LeadMagnet = {
  id: "lm-stable-123",
  workspace_id: "workspace-1",
  user_id: "user-1",
  title: "The B2B Founder LinkedIn Profile Lead Checklist",
  markdown_body: "# Profile checklist",
  source_url: null,
  source_type: "ai",
  public_slug: "profile-checklist",
  is_public: true,
  metadata: {
    resource_type: "checklist",
    estimated_minutes: 45,
    selection_summary: "A practical profile optimization checklist.",
    deliverables: ["Profile conversion checklist"],
  },
  created_at: "2026-07-29T12:00:00.000Z",
  updated_at: "2026-07-29T12:00:00.000Z",
};

describe("lead magnet resource cards", () => {
  test("shows a stable DiceBear Shapes icon and omits the time estimate", () => {
    const html = renderToStaticMarkup(
      createElement(LeadMagnetsManager, {
        initial: [LEAD_MAGNET],
        aiUsed: 1,
        aiLimit: 10,
      }),
    );

    expect(html).toContain(
      'src="https://api.dicebear.com/10.x/shapes/svg?seed=lm-stable-123"',
    );
    expect(html).toContain('alt=""');
    expect(html).not.toContain("lucide-scroll-text");
    expect(html).not.toContain("lucide-clock");
    expect(html).not.toContain("45 min");
  });
});
