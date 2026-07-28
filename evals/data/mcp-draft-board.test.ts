import { describe, expect, test } from "vitest";
import { buildMcpDraftMeta } from "@/lib/mcp/register-resources";
import {
  formatCreatedAt,
  isMcpCreatedDraft,
} from "@/app/(app)/dashboard/posts/drafts-list";
import type { Draft } from "@/lib/draft-view";

// MCP-created drafts: the create_draft tool stamps created_via + the modeled
// source into meta, and the board renders the MCP indicator + a created
// date+time on every card.

describe("buildMcpDraftMeta — meta stamped on every MCP draft", () => {
  test("a plain draft is tagged MCP with no source fields", () => {
    expect(buildMcpDraftMeta({})).toEqual({ created_via: "mcp" });
  });

  test("a modeled draft carries the source in the same contract as chat drafts", () => {
    expect(
      buildMcpDraftMeta({
        sourceUrl: "https://www.linkedin.com/posts/example-activity-123",
        sourcePostId: "47e34a0a-f729-4c86-9186-ed008f928972",
      }),
    ).toEqual({
      created_via: "mcp",
      source: "model_source",
      source_url: "https://www.linkedin.com/posts/example-activity-123",
      source_post_id: "47e34a0a-f729-4c86-9186-ed008f928972",
    });
  });

  test("a source_url alone still marks the draft as modeled", () => {
    const meta = buildMcpDraftMeta({
      sourceUrl: "https://www.linkedin.com/posts/x",
    });
    expect(meta.source).toBe("model_source");
    expect(meta.source_url).toBe("https://www.linkedin.com/posts/x");
    expect(meta).not.toHaveProperty("source_post_id");
  });

  test("blank source strings are ignored", () => {
    expect(buildMcpDraftMeta({ sourceUrl: "   " })).toEqual({
      created_via: "mcp",
    });
  });
});

function draftWithMeta(meta: Record<string, unknown> | null): Draft {
  return {
    id: "d1",
    title: null,
    body: "body",
    kind: "post",
    status: "drafting",
    planToPostOn: null,
    chatId: null,
    createdAt: "2026-07-27T20:57:13.683108+00:00",
    leadMagnet: null,
    meta,
  };
}

describe("isMcpCreatedDraft — the board's MCP indicator", () => {
  test("true only for meta.created_via === 'mcp'", () => {
    expect(isMcpCreatedDraft(draftWithMeta({ created_via: "mcp" }))).toBe(true);
    expect(isMcpCreatedDraft(draftWithMeta({ source: "model_source" }))).toBe(false);
    expect(isMcpCreatedDraft(draftWithMeta(null))).toBe(false);
  });
});

describe("formatCreatedAt — the created date+time on every card", () => {
  test("renders month, day, and time", () => {
    const out = formatCreatedAt("2026-07-27T20:57:13.683108+00:00");
    expect(out).toMatch(/Jul 27/);
    expect(out).toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/i);
  });

  test("garbage input yields an empty string, never 'Invalid Date'", () => {
    expect(formatCreatedAt("not-a-date")).toBe("");
  });
});
