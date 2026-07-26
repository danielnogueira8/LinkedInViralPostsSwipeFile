import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workspace = readFileSync(
  "app/(app)/dashboard/chat-workspace.tsx",
  "utf8",
);

describe("Cowork coral context chips", () => {
  it("uses the shared coral treatment for giveaway and creator-style context", () => {
    expect(workspace).toContain("const CORAL_CONTEXT_CHIP_CLASSNAME =");
    expect(workspace).toContain(
      '"border-accent-brand/25 bg-accent-brand/[0.08] text-accent-brand"',
    );

    expect(
      workspace.match(/CORAL_CONTEXT_CHIP_CLASSNAME/g),
    ).toHaveLength(5);
    expect(workspace).toMatch(
      /\{pendingLeadMagnet && \([\s\S]{0,500}CORAL_CONTEXT_CHIP_CLASSNAME/,
    );
    expect(workspace).toMatch(
      /\{pendingCreatorStyle && \([\s\S]{0,500}CORAL_CONTEXT_CHIP_CLASSNAME/,
    );
    expect(workspace).toMatch(
      /\{message\.creatorStyle && \([\s\S]{0,500}CORAL_CONTEXT_CHIP_CLASSNAME/,
    );
    expect(workspace).toMatch(
      /\{message\.leadMagnet && \([\s\S]{0,500}CORAL_CONTEXT_CHIP_CLASSNAME/,
    );
  });

  it("leaves the post-format context treatment unchanged", () => {
    const pendingPostFormat = workspace.slice(
      workspace.lastIndexOf("            {pendingPostFormat && ("),
      workspace.lastIndexOf("            {pendingLeadMagnet && ("),
    );

    expect(pendingPostFormat).toContain("border-state-danger-border");
    expect(pendingPostFormat).toContain("bg-state-danger-bg");
    expect(pendingPostFormat).not.toContain("CORAL_CONTEXT_CHIP_CLASSNAME");
  });
});
