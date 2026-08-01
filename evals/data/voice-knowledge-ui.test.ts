import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const source = readFileSync(
  "app/(app)/dashboard/knowledge/interview-knowledge-review.tsx",
  "utf8",
);

describe("Interview Knowledge review UI contract", () => {
  test("labels proposal provenance and exposes accessible review actions", () => {
    expect(source).toContain("From your Context interview");
    expect(source).toContain('aria-label={`Approve ${item.title}`}');
    expect(source).toContain('aria-label={`Dismiss ${item.title}`}');
    expect(source).toContain("Review personal facts extracted");
  });

  test("keeps approved facts visible and removable", () => {
    expect(source).toContain('aria-label="Verified knowledge"');
    expect(source).toContain('aria-label={`Remove ${item.title}`}');
    expect(source).toContain("Approved");
  });

  test("collapses approved facts until the user asks to see them", () => {
    expect(source).toContain("const [showVerified, setShowVerified] = useState(false)");
    expect(source).toContain("Show approved (${verified.length})");
    expect(source).toContain('aria-controls="verified-knowledge-items"');
    expect(source).toContain("workspaceKnowledgeDisplayText(item)");
    expect(source).not.toContain("line-clamp-3");
  });
});
