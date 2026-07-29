import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const workspace = fs.readFileSync(
  path.join(process.cwd(), "app/(app)/dashboard/chat-workspace.tsx"),
  "utf8",
);

describe("Cowork Knowledge selector UI", () => {
  test("offers explicit Knowledge selection and sends only selected ids", () => {
    expect(workspace).toContain("Choose Knowledge sources");
    expect(workspace).toContain("knowledgeSourceIds");
    expect(workspace).toContain("pendingKnowledgeSources");
    expect(workspace).toContain('aria-label="Choose Knowledge sources"');
  });

  test("shows selected Knowledge as transparent message context", () => {
    expect(workspace).toContain("message.knowledgeSources");
    expect(workspace).toContain("Knowledge:");
  });
});
