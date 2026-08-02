import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENT_DISCARD_REASONS } from "@/lib/agent-inbox/feedback";

const source = readFileSync(
  "app/(app)/dashboard/agent-inbox.tsx",
  "utf8",
);

describe("Agent Inbox dismissal feedback", () => {
  it("offers concrete quality reasons instead of a silent discard", () => {
    expect(AGENT_DISCARD_REASONS).toEqual([
      "Not relevant to me",
      "Too generic",
      "I've already said this",
      "Weak proof",
      "Forced connection",
      "Not timely",
    ]);
    expect(source).toContain("AGENT_DISCARD_REASONS.map");
    expect(source).toContain("helps every agent rank future recommendations");
  });
});
