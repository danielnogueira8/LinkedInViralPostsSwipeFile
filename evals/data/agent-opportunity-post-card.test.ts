import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  normalizeAgentSourcePost,
} from "@/lib/agent-loop/source-post-card";

const BRIEFING_ROUTE = readFileSync(
  "app/api/agent/briefing/route.ts",
  "utf8",
);
const BRIEFING_UI = readFileSync(
  "app/(app)/dashboard/agent-briefing.tsx",
  "utf8",
);
const POST_CARD = readFileSync("components/post-card.tsx", "utf8");

describe("Agent opportunity source-post cards", () => {
  it("normalizes the posts query into the shared PostCard shape", () => {
    expect(
      normalizeAgentSourcePost({
        id: "post-1",
        text: "The complete original post",
        post_url: "https://www.linkedin.com/posts/1",
        post_type: "lead_magnet",
        posted_at: "2026-07-20T12:00:00.000Z",
        reactions: null,
        comments: 18,
        reposts: null,
        media_type: null,
        media_urls: null,
        visual_kind: null,
        accounts: [
          {
            name: "Ada Lovelace",
            niche: "Technology",
            linkedin_handle: "ada",
            profile_pic_url: "https://example.com/ada.jpg",
          },
        ],
      }),
    ).toMatchObject({
      id: "post-1",
      text: "The complete original post",
      post_type: "lead_magnet",
      reactions: 0,
      comments: 18,
      reposts: 0,
      media_type: "none",
      media_urls: [],
      accounts: {
        name: "Ada Lovelace",
        linkedin_handle: "ada",
      },
    });
  });

  it("rejects malformed rows instead of handing an invalid card to the client", () => {
    expect(normalizeAgentSourcePost(null)).toBeNull();
    expect(normalizeAgentSourcePost({ id: null })).toBeNull();
  });

  it("fetches the shared swipe-card columns and returns a nested source post", () => {
    expect(BRIEFING_ROUTE).toContain("SWIPE_POST_COLS");
    expect(BRIEFING_ROUTE).toContain("normalizeAgentSourcePost");
    expect(BRIEFING_ROUTE).toContain("source_post:");
  });

  it("renders opportunities with the shared PostCard rather than a headline row", () => {
    expect(BRIEFING_UI).toContain('from "@/components/post-card"');
    expect(BRIEFING_UI).toContain("<PostCard");
    expect(BRIEFING_UI).toContain("post={opportunity.source_post}");
    expect(BRIEFING_UI).toContain('data-testid="agent-model-post-card"');
    expect(BRIEFING_UI).not.toContain(
      '<p className="min-w-0 flex-1 truncate text-sm text-foreground">',
    );
  });

  it("keeps Agent actions in the reusable card without changing Swipe callers", () => {
    expect(POST_CARD).toContain("footerActions");
    expect(BRIEFING_UI).toContain("Draft it");
    expect(BRIEFING_UI).toContain('aria-label="Not relevant"');
  });
});
