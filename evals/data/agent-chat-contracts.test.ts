import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  AgentEventSchema,
  ArtifactSchema,
  AskQuestionSchema,
  PlanStepSchema,
} from "@/lib/agent/contracts";

describe("agent and chat contracts", () => {
  test("accepts the observable events shared by the runtime and client", () => {
    expect(
      AgentEventSchema.safeParse({
        type: "artifact",
        artifact: {
          id: "draft-1",
          kind: "post",
          title: "Draft",
          body: "A publishable post",
        },
      }).success,
    ).toBe(true);
    expect(
      AgentEventSchema.safeParse({
        type: "plan_update",
        steps: [{ id: "draft", label: "Draft the post", status: "active" }],
      }).success,
    ).toBe(true);
    expect(
      AgentEventSchema.safeParse({
        type: "done",
        message: {
          content: "Done",
          tool_calls: null,
          artifacts: [],
          toolMessages: [
            {
              role: "tool",
              content: "result",
              tool_call_id: "call-1",
            },
          ],
          inputTokens: 1,
          outputTokens: 1,
        },
      }).success,
    ).toBe(true);
  });

  test("rejects malformed artifacts, plans, questions, and events", () => {
    expect(
      ArtifactSchema.safeParse({
        id: "draft-1",
        kind: "post",
        title: "Draft",
        body: "   ",
      }).success,
    ).toBe(false);
    expect(
      ArtifactSchema.safeParse({
        id: "draft-1",
        kind: "post",
        title: "Draft",
        body: "A valid body",
        media_attachments: [{}],
      }).success,
    ).toBe(false);
    expect(
      PlanStepSchema.safeParse({ id: "draft", label: "", status: "active" }).success,
    ).toBe(false);
    expect(
      AskQuestionSchema.safeParse({
        question: "Which direction?",
        options: ["Only one"],
        allowOther: true,
      }).success,
    ).toBe(false);
    expect(AgentEventSchema.safeParse({ type: "text", delta: 42 }).success).toBe(false);
    expect(
      AgentEventSchema.safeParse({
        type: "done",
        message: {
          content: "Done",
          tool_calls: null,
          artifacts: [],
          toolMessages: [{ role: "tool", content: "result" }],
          inputTokens: 1,
          outputTokens: 1,
        },
      }).success,
    ).toBe(false);
  });

  test("contract modules never depend on the runtime loop", () => {
    const source = readFileSync("lib/agent/contracts.ts", "utf8");
    const specialistSource = readFileSync(
      "lib/agent/specialists/contracts.ts",
      "utf8",
    );

    expect(source).not.toMatch(/from ["']@\/lib\/agent\/run["']/);
    expect(source).not.toMatch(/from ["']\.\/run["']/);
    expect(specialistSource).not.toMatch(/from ["']@\/lib\/agent\/run["']/);
  });

});
