import { describe, expect, test } from "vitest";
import { validateLeadMagnetAdapterResponse } from "@/lib/lead-magnet-ai";
import type { CompleteResult } from "@/lib/openrouter";

function response(
  toolArgs: Record<string, unknown> | null,
  text = "",
): CompleteResult {
  return {
    text,
    toolArgs,
    finishReason: "tool_calls",
    usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
    citations: [],
  };
}

describe("lead magnet adapter response contract", () => {
  test("accepts a structured title and complete markdown body", () => {
    const valid = response({
      title: "Founder Content Audit",
      markdown_body: `## How to use this resource\n\n${"Run this practical audit step. ".repeat(8)}`,
    });

    expect(validateLeadMagnetAdapterResponse(valid)).toBe(valid);
  });

  test.each([
    response(null, "A free-text guide must not bypass the forced tool contract."),
    response({ title: "Missing body" }),
    response({ markdown_body: "A complete body without a title is invalid." }),
    response({ title: "Thin", markdown_body: "Too short." }),
  ])("rejects malformed or incomplete structured output", (invalid) => {
    expect(() => validateLeadMagnetAdapterResponse(invalid)).toThrow(
      /required structured title or markdown body/i,
    );
  });
});
