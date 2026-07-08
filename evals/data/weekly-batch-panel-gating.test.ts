import { describe, expect, test } from "vitest";
import {
  shouldShowBatchStatusForChat,
  type Artifact,
  type Message,
} from "@/app/(app)/dashboard/chat-workspace";

function msg(overrides: Partial<Message> = {}): Message {
  return {
    id: "m1",
    role: "assistant",
    text: "",
    ...overrides,
  };
}

function artifact(batchId: string): Artifact {
  return {
    id: `a-${batchId}`,
    kind: "post",
    title: "Draft",
    body: "Draft body",
    meta: { source: "weekly_batch", batch_id: batchId },
  };
}

describe("weekly batch panel gating", () => {
  test("does not show a settled workspace run on an unrelated old E2E batch chat", () => {
    expect(
      shouldShowBatchStatusForChat({
        title: "Weekly batch — E2E 123",
        messages: [],
        artifacts: [],
        run: {
          id: "latest-real-run",
          status: "done",
          total: 7,
          created: 5,
          attempted: 7,
        },
      }),
    ).toBe(false);
  });

  test("shows a live run on a freshly-created batch chat before artifacts land", () => {
    expect(
      shouldShowBatchStatusForChat({
        title: "Weekly batch — Jul 8",
        messages: [],
        artifacts: [],
        run: {
          id: "live-run",
          status: "running",
          total: 7,
          created: 1,
          attempted: 2,
        },
      }),
    ).toBe(true);
  });

  test("shows a settled run only when the chat has an artifact from that batch", () => {
    expect(
      shouldShowBatchStatusForChat({
        title: "Weekly batch — Jul 8",
        messages: [msg({ text: "Review them on your Posts page" })],
        artifacts: [artifact("run-1")],
        run: {
          id: "run-1",
          status: "done",
          total: 7,
          created: 5,
          attempted: 7,
        },
      }),
    ).toBe(true);
  });

  test("does not show a settled run when only another batch artifact is present", () => {
    expect(
      shouldShowBatchStatusForChat({
        title: "Weekly batch — Jul 8",
        messages: [msg({ text: "Review them on your Posts page" })],
        artifacts: [artifact("older-run")],
        run: {
          id: "latest-run",
          status: "done",
          total: 7,
          created: 5,
          attempted: 7,
        },
      }),
    ).toBe(false);
  });
});
