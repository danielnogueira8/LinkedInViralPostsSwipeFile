/**
 * Mobile information architecture, kept separate from rendering so the
 * lifecycle and overflow grouping remain an explicit product contract.
 */
export const MOBILE_PRIMARY_PATHS = [
  "/dashboard/agent",
  "/dashboard",
  "/dashboard/swipe",
  "/dashboard/posts",
  "/dashboard/bookmarks",
] as const;

export const MOBILE_MORE_SECTIONS = [
  {
    label: "Inspiration",
    paths: ["/dashboard/accounts", "/dashboard/templates"],
  },
  {
    label: "Build your system",
    paths: [
      "/dashboard/lead-magnets",
      "/dashboard/voice",
      "/dashboard/creator-styles",
      "/dashboard/skills",
      "/dashboard/claude",
    ],
  },
  {
    label: "Measure & manage",
    paths: ["/dashboard/analytics", "/dashboard/settings"],
  },
] as const;
