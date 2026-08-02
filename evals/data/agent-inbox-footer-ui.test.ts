import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const source = readFileSync(
  new URL("../../app/(app)/dashboard/agent-inbox.tsx", import.meta.url),
  "utf8",
);

describe("agent inbox footer", () => {
  test("gives recent activity the full footer width", () => {
    expect(source).toContain(
      'className="mt-8 border-t border-border/70 pt-6"',
    );
    expect(source).toContain("Recent activity");
    expect(source).not.toContain("Evidence behind the queue");
    expect(source).not.toContain("evidenceKinds");
    expect(source).not.toContain("lg:grid-cols-[0.9fr_1.1fr]");
  });
});
