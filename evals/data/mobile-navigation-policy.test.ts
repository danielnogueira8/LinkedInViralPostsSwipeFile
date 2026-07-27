import { describe, expect, test } from "vitest";
import {
  MOBILE_MORE_SECTIONS,
  MOBILE_PRIMARY_PATHS,
} from "@/lib/mobile-navigation-policy";
import { NAV_SECTIONS } from "@/app/(app)/dashboard/nav-destinations";

describe("mobile navigation lifecycle", () => {
  test("keeps the agent and existing primary destinations one tap away", () => {
    expect(MOBILE_PRIMARY_PATHS).toEqual([
      "/dashboard/agent",
      "/dashboard",
      "/dashboard/swipe",
      "/dashboard/posts",
      "/dashboard/bookmarks",
    ]);
    expect(MOBILE_PRIMARY_PATHS).not.toContain("/dashboard/templates");
  });

  test("keeps research tools in the first overflow group", () => {
    expect(MOBILE_MORE_SECTIONS[0]).toEqual({
      label: "Inspiration",
      paths: ["/dashboard/accounts", "/dashboard/templates"],
    });
  });

  test("keeps every destination unique across primary and overflow navigation", () => {
    const paths = [
      ...MOBILE_PRIMARY_PATHS,
      ...MOBILE_MORE_SECTIONS.flatMap((section) => section.paths),
    ];
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("keeps every desktop destination reachable on mobile", () => {
    const mobile: Set<string> = new Set([
      ...MOBILE_PRIMARY_PATHS,
      ...MOBILE_MORE_SECTIONS.flatMap((section) => section.paths),
    ]);
    for (const section of NAV_SECTIONS) {
      for (const item of section.items) {
        expect(mobile.has(item.href), item.href).toBe(true);
      }
    }
  });
});
