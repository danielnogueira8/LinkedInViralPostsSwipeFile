import { describe, expect, test } from "vitest";
import {
  validateLeadMagnetAdapterResponse,
  salvageLeadMagnetContent,
} from "@/lib/lead-magnet-ai";
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
    model: "openai/gpt-5.6-luna",
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
    response(null, "Too short to be a real guide."),
    response({ title: "Missing body" }),
    response({ title: "Thin", markdown_body: "Too short." }),
    response(null, ""),
    response({}, "  "),
  ])("rejects when NEITHER tool args nor text yield a usable guide", (invalid) => {
    expect(() => validateLeadMagnetAdapterResponse(invalid)).toThrow(
      /required structured title or markdown body/i,
    );
  });

  // Regression: gpt-5.6-luna on the fuller prod prompt answers in reply TEXT
  // (or omits the tool title), so the old toolArgs-only check 500'd with
  // "Adapter response validation failed" even though a complete guide was
  // present. Salvage from response.text (+ the H1 as title) must pass.
  test("accepts a complete guide delivered as reply TEXT (no tool args)", () => {
    const body = `# Founder LinkedIn Operating System\n\n${"A genuinely useful, practical step for founders. ".repeat(6)}`;
    const textOnly = response(null, body);
    expect(validateLeadMagnetAdapterResponse(textOnly)).toBe(textOnly);
    const salvaged = salvageLeadMagnetContent(textOnly);
    expect(salvaged.title).toBe("Founder LinkedIn Operating System");
    expect(salvaged.markdown.length).toBeGreaterThanOrEqual(80);
  });

  test("accepts markdown_body present but title missing — derives title from H1", () => {
    const body = `# The B2B Content OS\n\n${"Do this concrete, repeatable weekly action. ".repeat(6)}`;
    const noTitle = response({ markdown_body: body });
    expect(validateLeadMagnetAdapterResponse(noTitle)).toBe(noTitle);
    expect(salvageLeadMagnetContent(noTitle).title).toBe("The B2B Content OS");
  });

  test("title-less, heading-less text still derives a title from the first line", () => {
    const body = `Weekly LinkedIn system for founders\n\n${"A specific, usable instruction here. ".repeat(6)}`;
    const salvaged = salvageLeadMagnetContent(response(null, body));
    expect(salvaged.title).toBe("Weekly LinkedIn system for founders");
    expect(salvaged.markdown.length).toBeGreaterThanOrEqual(80);
  });

  test("prefers the structured tool args when both are present", () => {
    const salvaged = salvageLeadMagnetContent(
      response(
        { title: "Tool Title", markdown_body: "# Tool Body\n\nStructured content." },
        "# Text Body\n\nReply-text content that should be ignored.",
      ),
    );
    expect(salvaged.title).toBe("Tool Title");
    expect(salvaged.markdown).toContain("Tool Body");
    expect(salvaged.markdown).not.toContain("Text Body");
  });
});
