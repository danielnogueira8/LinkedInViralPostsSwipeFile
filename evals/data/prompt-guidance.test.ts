import { describe, expect, test } from "vitest";
import {
  buildAnswerSystemPrompt,
  INTERACTIVE_RESPONSE_GUIDANCE,
} from "@/lib/agent/prompt-guidance";

describe("interactive answer prompt guidance", () => {
  test("calibrates concise, warm answers without weakening artifact boundaries", () => {
    expect(INTERACTIVE_RESPONSE_GUIDANCE).toContain(
      "Use a warm, collaborative tone",
    );
    expect(INTERACTIVE_RESPONSE_GUIDANCE).toContain(
      "Provide a concise, focused answer",
    );
    expect(INTERACTIVE_RESPONSE_GUIDANCE).toContain(
      "keep examples minimal unless the user asks for depth",
    );

    expect(buildAnswerSystemPrompt("answer")).toContain(
      "not authorized to create or edit an artifact",
    );
    expect(buildAnswerSystemPrompt("review")).toContain(
      "Give critique or feedback only",
    );
  });
});
