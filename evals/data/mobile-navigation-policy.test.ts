import { describe, expect, test } from "vitest";
import {
  MOBILE_MORE_SECTIONS,
  MOBILE_PRIMARY_PATHS,
} from "@/lib/mobile-navigation-policy";

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
});
