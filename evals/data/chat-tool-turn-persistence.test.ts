import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { persistChatAssistantTurn } from "@/lib/chat-message-persistence";

describe("chat assistant tool-turn persistence", () => {
  test("sends the complete assistant and tool turn through one RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "assistant-1", error: null });
    const toolCalls = [
      {
        id: "call-1",
        type: "function" as const,
        function: { name: "get_voice", arguments: "{}" },
      },
    ];
    const toolMessages = [
      { content: '{"old":true}', tool_call_id: "call-from-earlier-round" },
      { content: '{"ok":true}', tool_call_id: "call-1" },
    ];

    await expect(
      persistChatAssistantTurn({
        sb: { rpc } as never,
        chatId: "chat-1",
        workspaceId: "workspace-1",
        content: "",
        toolCalls,
        artifacts: null,
        inputTokens: 10,
        outputTokens: 5,
        toolMessages,
        terminalReason: "done",
      }),
    ).resolves.toEqual({ error: null });

    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith(
      "persist_chat_assistant_turn",
      expect.objectContaining({
        p_tool_calls: toolCalls,
        p_tool_messages: [toolMessages[1]],
        p_terminal_reason: "done",
      }),
    );
  });

  test("the migration inserts the assistant declaration before tool outputs", () => {
    const sql = readFileSync(
      resolve(process.cwd(), "db/migration-073-chat-assistant-turn-persistence.sql"),
      "utf8",
    );
    const assistantInsert = sql.indexOf("'assistant'");
    const toolInsert = sql.indexOf("'tool'", assistantInsert + 1);

    expect(assistantInsert).toBeGreaterThan(-1);
    expect(toolInsert).toBeGreaterThan(assistantInsert);
    expect(sql).toContain("with ordinality");
  });
});
