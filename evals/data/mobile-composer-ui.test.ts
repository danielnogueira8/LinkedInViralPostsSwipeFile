import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const workspace = readFileSync(
  "app/(app)/dashboard/chat-workspace.tsx",
  "utf8",
);

describe("mobile Cowork composer UI", () => {
  test("keeps context and post panel controls in normal layout flow", () => {
    expect(workspace).toContain(
      'data-testid="mobile-composer-panel-shortcuts"',
    );
    expect(workspace).toContain(
      'hasContext && hasDraftPanel ? "grid-cols-2" : "grid-cols-1"',
    );
    expect(workspace).not.toContain(
      'hasDraftPanel ? "bottom-44" : "bottom-32"',
    );
    expect(workspace).toContain("flex h-11 min-w-0 items-center");
  });

  test("gives the source post a mobile-friendly content hierarchy", () => {
    expect(workspace).toContain('data-testid="composer-source-card"');
    expect(workspace).toContain("const sourceCopy =");
    expect(workspace).toContain(
      "rounded-xl border border-border bg-muted/35",
    );
  });

  test("keeps the mobile sheets named and keyboard-dismissable", () => {
    expect(workspace).toContain('aria-label="Chat context"');
    expect(workspace).toContain(
      'aria-label={`${ARTIFACT_PANEL_TITLE} panel`}',
    );
    expect(workspace).toContain('if (event.key !== "Escape") return;');
    expect(workspace).toContain("onKeyDown={trapDialogFocus}");
    expect(workspace).toContain('if (event.key !== "Tab") return;');
    expect(workspace).toContain("mobileContextTriggerRef.current?.focus()");
    expect(workspace).toContain("mobileDraftsTriggerRef.current?.focus()");
  });
});
