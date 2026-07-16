import { describe, expect, it } from "vitest";
import {
  WeeklyBatchStartResponseSchema,
  encodeChatSseFrame,
  parseChatSseFrame,
} from "@/lib/transport/contracts";

describe("validated transport contracts", () => {
  it("accepts the complete weekly-batch start envelope", () => {
    expect(WeeklyBatchStartResponseSchema.parse({
      ok: true,
      jobId: "job-1",
      batchId: "batch-1",
      runId: "batch-1",
      chatId: null,
      status: "queued",
    })).toMatchObject({ ok: true, runId: "batch-1" });
  });

  it("rejects incomplete success envelopes instead of guessing defaults", () => {
    expect(WeeklyBatchStartResponseSchema.safeParse({ ok: true }).success).toBe(false);
  });

  it("uses one schema for server encoding and client parsing of SSE", () => {
    const wire = encodeChatSseFrame("text", { delta: "hello" });
    expect(wire).toBe('event: text\ndata: {"delta":"hello"}\n\n');
    expect(parseChatSseFrame("text", { delta: "hello" })).toEqual({
      event: "text",
      data: { delta: "hello" },
    });
  });

  it("drops malformed and unknown SSE frames at both boundaries", () => {
    expect(encodeChatSseFrame("text", { delta: 42 })).toBeNull();
    expect(parseChatSseFrame("mystery", {})).toBeNull();
  });

  it("round-trips every Cowork SSE event variant", () => {
    const frames = [
      ["tool_start", { id: "t1", name: "search", args: "{}" }],
      ["tool_end", { id: "t1", name: "search", ok: true }],
      ["plan", { steps: [{ id: "s1", label: "Research", status: "active" }] }],
      ["plan_update", { steps: [{ id: "s1", label: "Research", status: "done" }] }],
      ["ask", { question: "Which?", options: ["A", "B"], allowOther: true }],
      ["preference_saved", { id: "p1", rule: "No hashtags" }],
      ["artifact", { id: "a1", kind: "post", title: "Draft", body: "A complete post" }],
      [
        "done",
        {
          artifacts: [],
          usage: {
            total_credits: 2,
            total_cost_usd: 0.01,
            stages: [
              {
                kind: "writing",
                credits: 2,
                cost_usd: 0.01,
                models: ["openai/gpt-5.6-luna"],
              },
            ],
          },
        },
      ],
      ["error", { message: "Stopped", code: "cancelled" }],
    ] as const;
    for (const [event, data] of frames) {
      expect(encodeChatSseFrame(event, data)).not.toBeNull();
      expect(parseChatSseFrame(event, data)?.event).toBe(event);
    }
  });
});
