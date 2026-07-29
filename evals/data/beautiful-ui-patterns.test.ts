import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { LoadingState } from "@/components/ui/loading-state";
import { SearchField } from "@/components/ui/search-field";

const source = (path: string) => readFileSync(path, "utf8");

describe("shared Beautiful UI interaction patterns", () => {
  test("search fields expose a clear action without losing the native search semantics", () => {
    const html = renderToStaticMarkup(
      createElement(SearchField, {
        value: "hooks",
        onChange: () => undefined,
        onClear: () => undefined,
        "aria-label": "Search posts",
      }),
    );

    expect(html).toContain('type="search"');
    expect(html).toContain('aria-label="Search posts"');
    expect(html).toContain('aria-label="Clear search"');
    expect(html).toContain('value="hooks"');
  });

  test("loading state announces useful work and includes a reduced-motion-safe pixel grid", () => {
    const html = renderToStaticMarkup(
      createElement(LoadingState, {
        label: "Loading posts",
      }),
    );

    expect(html).toContain('role="status"');
    expect(html).toContain("Loading posts");
    expect(html.match(/data-loading-pixel/g)).toHaveLength(9);
    expect(source("components/ui/loading-state.module.css")).toContain(
      "prefers-reduced-motion: reduce",
    );
  });

  test("the dashboard shell makes search and a new Cowork session directly available", () => {
    const nav = source("app/(app)/dashboard/nav.tsx");
    const chrome = source("app/(app)/dashboard/client-chrome.tsx");

    expect(nav).toContain("Search the workspace");
    expect(nav).toContain("/dashboard?new=1");
    expect(nav).toContain("OPEN_COMMAND_PALETTE_EVENT");
    expect(chrome).toContain("OPEN_COMMAND_PALETTE_EVENT");
    expect(source("lib/ui-events.ts")).toContain(
      '"swipein:open-command-palette"',
    );
    expect(
      source("components/workspace-search-button.tsx"),
    ).toContain("Search the workspace");
  });

  test("recurring search surfaces use the shared field", () => {
    for (const path of [
      "app/(app)/dashboard/analytics/view.tsx",
      "app/(app)/dashboard/posts/drafts-list.tsx",
      "app/(app)/dashboard/knowledge/workspace.tsx",
      "app/(app)/dashboard/lead-magnets/manager.tsx",
      "app/(app)/dashboard/accounts/creator-picker.tsx",
      "app/(app)/dashboard/chat-workspace.tsx",
      "app/(app)/dashboard/swipe/filters.tsx",
    ]) {
      expect(source(path), path).toContain("<SearchField");
    }
  });

  test("route fallbacks share the same visible loading language", () => {
    for (const path of [
      "app/(app)/dashboard/agent/loading.tsx",
      "app/(app)/dashboard/analytics/loading.tsx",
      "app/(app)/dashboard/bookmarks/loading.tsx",
      "app/(app)/dashboard/claude/loading.tsx",
      "app/(app)/dashboard/creator-styles/loading.tsx",
      "app/(app)/dashboard/integrations/loading.tsx",
      "app/(app)/dashboard/knowledge/loading.tsx",
      "app/(app)/dashboard/lead-magnets/loading.tsx",
      "app/(app)/dashboard/posts/loading.tsx",
      "app/(app)/dashboard/settings/loading.tsx",
      "app/(app)/dashboard/skills/loading.tsx",
      "app/(app)/dashboard/swipe/loading.tsx",
      "app/(app)/dashboard/templates/loading.tsx",
      "app/(app)/dashboard/voice/loading.tsx",
    ]) {
      expect(source(path), path).toContain("<LoadingState");
    }
  });
});
