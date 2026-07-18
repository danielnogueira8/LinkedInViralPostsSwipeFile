import { describe, expect, test } from "vitest";
import {
  requestsDirectSourceModeling,
  requestsSourceModeling,
} from "@/lib/agent/source-policy";

describe("requestsSourceModeling", () => {
  test("recognizes single and multi auto-source modeling requests", () => {
    expect(
      requestsSourceModeling(
        "Find a top post in my swipe file and rewrite it in my voice.",
      ),
    ).toBe(true);
    expect(
      requestsSourceModeling(
        "Find 4 top-performing regular posts in my swipe file and rewrite them in my voice.",
      ),
    ).toBe(true);
    expect(
      requestsSourceModeling(
        "Find 3 posts in my swipe file and create 3 posts modeled after them.",
      ),
    ).toBe(true);
    expect(
      requestsSourceModeling(
        "Find 3 recent posts and write three posts modelling their formats.",
      ),
    ).toBe(true);
    expect(
      requestsSourceModeling(
        "Find three viral posts and replicate their formats for my audience.",
      ),
    ).toBe(true);
    expect(
      requestsSourceModeling(
        "Find 4 top-performing posts in my swipe file and turn them into original posts.",
      ),
    ).toBe(true);
    expect(
      requestsSourceModeling(
        "Find three posts in my swipe file to model.",
      ),
    ).toBe(true);
  });

  test("keeps the direct lane restricted to a single modeled source", () => {
    expect(
      requestsDirectSourceModeling(
        "Find 4 top-performing regular posts in my swipe file and rewrite them in my voice.",
      ),
    ).toBe(false);
  });

  test("does not classify analysis, original writing, or source opt-outs as modeling", () => {
    expect(requestsSourceModeling("Show me my top 5 posts by reactions.")).toBe(false);
    expect(requestsSourceModeling("Write 4 original posts about content writing.")).toBe(false);
    expect(
      requestsSourceModeling(
        "Find an example, but do not use sources or model a source post.",
      ),
    ).toBe(false);
    expect(
      requestsSourceModeling(
        "Find the top posts about AI models and show me their common themes.",
      ),
    ).toBe(false);
    expect(
      requestsSourceModeling(
        "Find 3 viral posts about model trains and write 3 original posts.",
      ),
    ).toBe(false);
    expect(
      requestsSourceModeling(
        "Find top posts that discuss modeling data and summarize the trends.",
      ),
    ).toBe(false);
    expect(
      requestsSourceModeling(
        "Find top posts about AI models and then rewrite my profile summary.",
      ),
    ).toBe(false);
    for (const request of [
      "Find 3 top posts and turn them into a comparison table.",
      "Find 3 top posts and turn them into a research summary.",
      "Find 3 top posts and turn each one into a slide.",
    ]) {
      expect(requestsSourceModeling(request)).toBe(false);
    }
  });
});
