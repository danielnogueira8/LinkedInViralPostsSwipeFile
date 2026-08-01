import { describe, expect, test } from "vitest";
import {
  agentMessageState,
  isAgentMessageUnread,
} from "@/lib/agent-inbox";

describe("Agent inbox message state", () => {
  test("keeps unread and read separate from an active idea", () => {
    expect(agentMessageState({ status: "active", readAt: null })).toBe(
      "unread",
    );
    expect(
      agentMessageState({
        status: "active",
        readAt: "2026-08-01T08:00:00.000Z",
      }),
    ).toBe("read");
  });

  test("keeps terminal lifecycle outcomes distinguishable", () => {
    expect(agentMessageState({ status: "acted", readAt: null })).toBe("done");
    expect(agentMessageState({ status: "discarded", readAt: null })).toBe(
      "discarded",
    );
    expect(agentMessageState({ status: "snoozed", readAt: null })).toBe(
      "archived",
    );
    expect(agentMessageState({ status: "expired", readAt: null })).toBe(
      "expired",
    );
  });

  test("only unread active ideas contribute to the unread badge", () => {
    expect(isAgentMessageUnread({ status: "active", readAt: null })).toBe(true);
    expect(
      isAgentMessageUnread({
        status: "active",
        readAt: "2026-08-01T08:00:00.000Z",
      }),
    ).toBe(false);
    expect(isAgentMessageUnread({ status: "acted", readAt: null })).toBe(false);
  });
});
