import { describe, test, expect, vi, beforeEach } from "vitest";
import type { ChatMessage, ToolDef } from "@/lib/openrouter";

const captured: { messages: ChatMessage[]; tools: ToolDef[] } = {
  messages: [],
  tools: [],
};

vi.mock("@/lib/openrouter", async (orig) => {
  const actual = await orig<typeof import("@/lib/openrouter")>();
  return {
    ...actual,
    logOpenRouterUsage: async () => undefined,
    streamChat: (opts: { messages: ChatMessage[]; tools: ToolDef[] }) => {
      captured.messages = opts.messages;
      captured.tools = opts.tools;
      return (async function* () {
        yield { text: "ok.", finishReason: "stop" as const };
      })();
    },
  };
});

const { runAgent, explicitlyRequestsSourceDiscovery } = await import("@/lib/agent/run");

async function run(message: string): Promise<void> {
  for await (const _ of runAgent({
    history: [{ role: "user", content: message }],
    workspaceId: "ws",
    hasModelSource: true,
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
});
