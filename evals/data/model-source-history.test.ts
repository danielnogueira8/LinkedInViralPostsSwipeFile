import { describe, expect, test } from "vitest";
import {
  chatHistoryWithModelSources,
  customSkillsToolCall,
  extractModelSourceId,
  modelSourceEnvelope,
  modelSourceToolCall,
} from "@/app/api/chats/[id]/stream/route";
import type { ToolCall } from "@/lib/openrouter";

type DbRow = {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls: ToolCall[] | null;
  tool_call_id: string | null;
};

describe("model-source history", () => {
  test("template sources are restored into future model history", () => {
    const marker = modelSourceToolCall("11111111-1111-1111-1111-111111111111");
    const rows: DbRow[] = [
      {
        role: "user",
        content: "Use this template for a post about AI-assisted client wins.",
        tool_calls: [marker],
        tool_call_id: null,
      },
      {
        role: "assistant",
        content: "Which client stat should I use?",
        tool_calls: null,
        tool_call_id: null,
      },
      {
        role: "user",
        content: "Use the 30+ posts / 1,000+ comments stat.",
        tool_calls: null,
        tool_call_id: null,
      },
    ];
    const sources = new Map([
      [
        "11111111-1111-1111-1111-111111111111",
        {
          id: "11111111-1111-1111-1111-111111111111",
          source: "template",
          post_text: "I helped {client} get {result} without {pain}.",
        },
      ],
    ]);

    const history = chatHistoryWithModelSources(rows, sources);
    const first = history[0];

    expect(Array.isArray(first.content)).toBe(true);
    expect(JSON.stringify(first.content)).toContain("--- TEMPLATE TO FILL ---");
    expect(JSON.stringify(first.content)).toContain(
      "I helped {client} get {result} without {pain}.",
    );
    expect(history[2].content).toBe("Use the 30+ posts / 1,000+ comments stat.");
  });

  test("model-source marker can coexist with custom-skill marker", () => {
    const sourceId = "22222222-2222-2222-2222-222222222222";
    const calls = [modelSourceToolCall(sourceId), customSkillsToolCall(["cta"])];

    expect(extractModelSourceId(calls)).toBe(sourceId);
    expect(calls.map((c) => c.function.name)).toEqual([
      "_model_source_attached",
      "_custom_skills_applied",
    ]);
  });

  test("model source envelopes keep provenance-specific markers", () => {
    expect(
      modelSourceEnvelope({ source: "template", post_text: "Template body" }),
    ).toContain("--- TEMPLATE TO FILL ---");
    expect(
      modelSourceEnvelope({ source: "draft", post_text: "Draft body" }),
    ).toContain("--- POST TO REFINE ---");
    expect(
      modelSourceEnvelope({ source: "swipe", post_text: "Swipe body" }),
    ).toContain("--- POST TO MODEL AFTER ---");
  });
});
