import { describe, expect, test } from "vitest";
import { agentGuardLogLine } from "@/lib/agent/output-guard";

describe("agentGuardLogLine — structured guard logging contract", () => {
  test("emits one grep-able JSON line with guard details", () => {
    const line = agentGuardLogLine({
      workspaceId: "ws_1",
      chatKind: "chat",
      guard: "forced_final",
      reason: "tool_cap",
      details: { tool_calls_total: 14 },
    });

    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      agent_guard: {
        workspace_id: "ws_1",
        chat_kind: "chat",
        guard: "forced_final",
        reason: "tool_cap",
        details: { tool_calls_total: 14 },
      },
    });
    expect(line).toContain('"agent_guard"');
    expect(line).toContain('"guard":"forced_final"');
  });
});
