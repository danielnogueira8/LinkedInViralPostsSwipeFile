import { describe, expect, test } from "vitest";
import {
  AGENT_CHAT_TITLE,
  AGENT_SUGGESTED_BY,
  isAgentSuggestedMeta,
} from "@/lib/agent-loop/constants";

describe("agent-loop constants", () => {
  test("isAgentSuggestedMeta only matches the agent stamp", () => {
    expect(isAgentSuggestedMeta({ suggested_by: AGENT_SUGGESTED_BY })).toBe(true);
    expect(isAgentSuggestedMeta({ suggested_by: "user" })).toBe(false);
    expect(isAgentSuggestedMeta({})).toBe(false);
    expect(isAgentSuggestedMeta(null)).toBe(false);
    expect(isAgentSuggestedMeta(undefined)).toBe(false);
  });

  test("the system chat title is stable (sidebar robot icon keys off it)", () => {
    expect(AGENT_CHAT_TITLE).toBe("Your agent");
  });
});
