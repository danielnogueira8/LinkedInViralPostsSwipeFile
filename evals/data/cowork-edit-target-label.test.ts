import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const workspace = readFileSync(
  "app/(app)/dashboard/chat-workspace.tsx",
  "utf8",
);

describe("Cowork Edit target labels", () => {
  test("uses the numbered target in the chip, prompt, and selector", () => {
    expect(workspace).toContain(
      "const editTargetLabel = editTargetPost",
    );
    expect(workspace).toContain(
      "`What should change in ${editTargetLabel}?`",
    );
    expect(workspace).toContain(
      "`Edit · ${editTargetLabel}`",
    );
    expect(workspace).toContain("{numberedArtifactLabel(entry)}");
  });

  test("does not append the post's first line to Edit options", () => {
    expect(workspace).not.toContain(
      '{entry.label} — {entry.artifact.body.replace(/\\s+/g, " ").slice(0, 48)}',
    );
  });
});
