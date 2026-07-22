import { describe, expect, test } from "vitest";
import { resolveTrustedRefineTarget } from "@/lib/agent/chat-turn";
import type { Artifact } from "@/lib/agent/contracts";

describe("trusted refine target resolution", () => {
  test("prefers the latest chat-message artifact and preserves its exact bytes", () => {
    const older: Artifact = {
      id: "draft-1",
      kind: "post",
      title: "Original",
      body: "Older body.",
    };
    const latest: Artifact = {
      ...older,
      title: "Current",
      body: "  Current body with intentional outer whitespace.  ",
      meta: { skills: ["storytelling"] },
    };
    const resolved = resolveTrustedRefineTarget({
      targetId: latest.id,
      rows: [
        {
          role: "assistant",
          content: "",
          tool_calls: null,
          tool_call_id: null,
          artifacts: [older],
        },
        {
          role: "assistant",
          content: "",
          tool_calls: null,
          tool_call_id: null,
          artifacts: [latest],
        },
      ],
    });

    expect(resolved).toEqual(latest);
    expect(resolved?.body).toBe(latest.body);
  });

  test("resolves an explicitly selected older post instead of the latest post", () => {
    const selected: Artifact = {
      id: "post-1",
      kind: "post",
      title: "Post 1",
      body: "The selected first post.",
    };
    const latest: Artifact = {
      id: "post-2",
      kind: "post",
      title: "Post 2",
      body: "A newer post that must not become the context target.",
    };

    const resolved = resolveTrustedRefineTarget({
      targetId: selected.id,
      rows: [
        {
          role: "assistant",
          content: "",
          tool_calls: null,
          tool_call_id: null,
          artifacts: [selected],
        },
        {
          role: "assistant",
          content: "",
          tool_calls: null,
          tool_call_id: null,
          artifacts: [latest],
        },
      ],
    });

    expect(resolved).toEqual(selected);
  });
});
