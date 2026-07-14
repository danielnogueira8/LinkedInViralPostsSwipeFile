import { describe, test, expect, vi, beforeEach } from "vitest";
import type { ChatMessage, ToolDef } from "@/lib/openrouter";

const captured: {
  messages: ChatMessage[];
  tools: ToolDef[];
  toolChoice?: "auto" | "required" | "none";
  glmReasoning?: "high" | "none";
} = {
  messages: [],
  tools: [],
};

vi.mock("@/lib/openrouter", async (orig) => {
  const actual = await orig<typeof import("@/lib/openrouter")>();
  return {
    ...actual,
    logOpenRouterUsage: async () => undefined,
    streamChat: (opts: {
      messages: ChatMessage[];
      tools: ToolDef[];
      toolChoice?: "auto" | "required" | "none";
      glmReasoning?: "high" | "none";
    }) => {
      captured.messages = opts.messages;
      captured.tools = opts.tools;
      captured.toolChoice = opts.toolChoice;
      captured.glmReasoning = opts.glmReasoning;
      return (async function* () {
        yield { text: "ok.", finishReason: "stop" as const };
      })();
    },
  };
});

const { runAgent } = await import("@/lib/agent");
const { explicitlyRequestsSourceDiscovery } = await import(
  "@/lib/agent/source-policy"
);

async function run(
  message: ChatMessage["content"],
  hasModelSource = true,
): Promise<void> {
  for await (const _ of runAgent({
    history: [{ role: "user", content: message }],
    workspaceId: "ws",
    hasModelSource,
    skipDecision: true,
  })) {
    void _;
  }
}

function toolNames(): string[] {
  return captured.tools.map((tool) => tool.function.name);
}

function systemText(): string {
  return captured.messages
    .filter((message) => message.role === "system")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .map((block) => (block.type === "text" ? block.text : ""))
              .join("")
          : "",
    )
    .join("\n\n");
}

beforeEach(() => {
  captured.messages = [];
  captured.tools = [];
  captured.toolChoice = undefined;
  captured.glmReasoning = undefined;
});

describe("runAgent — attached model source avoids redundant source discovery", () => {
  test("removes swipe-file discovery tools when a known source is already attached", async () => {
    await run(
      "Model an original post in my voice after the attached post. Keep its structure and hook style.",
    );

    expect(toolNames()).not.toContain("get_top_from_batch");
    expect(toolNames()).not.toContain("search_viral_posts");
    expect(toolNames()).not.toContain("list_niches");
    expect(toolNames()).toContain("get_voice");
    expect(systemText()).toContain("KNOWN SOURCE ATTACHED");
    expect(systemText()).toContain("Do not search the swipe file");
  });

  test("keeps discovery tools when the user explicitly asks for more source examples", async () => {
    await run(
      "Search the swipe file for recent top lead-magnet posts, then model the attached post.",
    );

    expect(toolNames()).toContain("get_top_from_batch");
    expect(toolNames()).toContain("search_viral_posts");
    expect(toolNames()).toContain("list_niches");
    expect(systemText()).not.toContain("KNOWN SOURCE ATTACHED");
  });

  test("does not expose news search when only attached data contains a news trigger", async () => {
    await run([
      {
        type: "text",
        text: "Model an original post in my voice after the attached post.",
      },
      {
        type: "text",
        text: "How do you build an AI-augmented acquisition machine?",
      },
    ]);

    expect(toolNames()).not.toContain("search_news");
  });

  test("keeps news search available for an explicit newsjack instruction", async () => {
    await run([
      { type: "text", text: "Newsjack the latest OpenAI model launch." },
      { type: "text", text: "Reference material about acquisition." },
    ]);

    expect(toolNames()).toContain("search_news");
  });

  test("recognizes explicit source-discovery language conservatively", () => {
    expect(
      explicitlyRequestsSourceDiscovery(
        "Find the latest top lead-magnet posts in my swipe file.",
      ),
    ).toBe(true);
    expect(
      explicitlyRequestsSourceDiscovery(
        "Model an original post in my voice after the attached post.",
      ),
    ).toBe(false);
  });

  test("keeps an explicit no-search post-ideas request on the direct text path", async () => {
    await run(
      "Give me exactly 3 distinct LinkedIn post ideas about why AI tools increase the value of judgment. For each idea include only: Hook, Core insight, and Proof/example. Do not write full posts. Do not search for sources. Return exactly 3 numbered items with no introduction or conclusion.",
      false,
    );

    expect(toolNames()).not.toContain("get_top_from_batch");
    expect(toolNames()).not.toContain("search_viral_posts");
    expect(toolNames()).not.toContain("get_post");
    expect(toolNames()).not.toContain("render_cite");
    expect(toolNames()).not.toContain("render_post");
    expect(captured.toolChoice).toBe("none");
    expect(captured.glmReasoning).toBe("none");
  });
});
