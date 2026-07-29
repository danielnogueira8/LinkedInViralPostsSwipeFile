import { createElement, type ComponentType } from "react";
import {
  Handshake,
  FileText,
  Magnet,
  SatelliteDish,
  Settings,
  Bookmark,
  AudioLines,
  Fingerprint,
  ChartNoAxesColumn,
  LayoutTemplate,
  LibraryBig,
  Plug,
} from "lucide-react";
import { ClaudeIcon } from "@/components/claude-icon";
import { SwipeInIcon } from "@/components/swipein-icon";
import { AiIcon } from "@/components/ai-icon";

// The sidebar uses the COLORED Claude mark (brand orange), same as the
// landing page and the Claude Workflows header — not the monochrome glyph.
// createElement, not JSX: this is a .ts file (JSX only parses in .tsx).
function ClaudeWorkflowsNavIcon({ className }: { className?: string }) {
  return createElement(ClaudeIcon, { variant: "brand", className });
}

export type NavDestination = {
  href: string;
  label: string;
  /** Space-constrained label (mobile bottom bar). */
  shortLabel?: string;
  icon: ComponentType<{ className?: string }>;
  tooltip?: string;
};

export type NavSection = {
  label: string;
  items: NavDestination[];
};

// Single source of truth for every dashboard destination. The desktop sidebar
// (nav.tsx), mobile chrome (mobile-nav.tsx), and the Cmd-K command palette all
// render from this list so labels, icons, and tooltips can never drift.
export const NAV_SECTIONS: NavSection[] = [
  {
    label: "Create",
    items: [
      {
        href: "/dashboard/agent",
        label: "Your Agent",
        icon: AiIcon,
        tooltip: "Review your weekly plan, agent drafts, and opportunities.",
      },
      { href: "/dashboard", label: "Cowork", icon: Handshake, tooltip: "Chat with the writing agent." },
      { href: "/dashboard/posts", label: "Posts", icon: FileText, tooltip: "Review, edit, schedule, and track your draft posts." },
      { href: "/dashboard/lead-magnets", label: "Lead Magnets", icon: Magnet, tooltip: "Create and share markdown resources for lead-magnet posts." },
    ],
  },
  {
    label: "Research",
    items: [
      { href: "/dashboard/swipe", label: "Swipe File", shortLabel: "Swipe", icon: SwipeInIcon, tooltip: "Browse source posts and saved bookmarks to model in Cowork." },
      { href: "/dashboard/accounts", label: "Creators", icon: SatelliteDish, tooltip: "Creators SwipeIn watches to fill your Swipe File with proven posts." },
    ],
  },
  {
    label: "Train",
    items: [
      { href: "/dashboard/voice", label: "Voice", icon: AudioLines, tooltip: "Your writing profile and voice preferences." },
      { href: "/dashboard/knowledge", label: "Knowledge", icon: LibraryBig, tooltip: "Your context interview and private sources for grounded writing." },
      { href: "/dashboard/creator-styles", label: "Creator Styles", icon: Fingerprint, tooltip: "Reusable writing-style profiles from creators you track." },
      { href: "/dashboard/templates", label: "Templates", icon: LayoutTemplate, tooltip: "Reusable content templates for posts and hooks." },
    ],
  },
  {
    label: "Tools",
    items: [
      { href: "/dashboard/analytics", label: "Analytics", icon: ChartNoAxesColumn, tooltip: "LinkedIn performance of posts published through SwipeIn." },
      { href: "/dashboard/claude", label: "Claude Workflows", icon: ClaudeWorkflowsNavIcon, tooltip: "Reusable AI workflows for content tasks." },
      { href: "/dashboard/integrations", label: "Integrations", icon: Plug, tooltip: "Connect third-party tools like LeadShark." },
      { href: "/dashboard/settings", label: "Settings", icon: Settings, tooltip: "Workspace settings and publishing connections." },
    ],
  },
];

// Bookmarks is a view of the Swipe File (/dashboard/bookmarks redirects to
// /dashboard/swipe?tab=bookmarks), so it is deliberately NOT a desktop sidebar
// entry — its active state would never stick after the redirect. It IS a
// mobile primary tab and a command-palette jump target, where the redirect
// doesn't matter.
export const BOOKMARKS_DESTINATION: NavDestination = {
  href: "/dashboard/bookmarks",
  label: "Bookmarks",
  icon: Bookmark,
  tooltip: "Saved swipe-file posts and shared libraries.",
};

export const NAV_DESTINATIONS: NavDestination[] = [
  ...NAV_SECTIONS.flatMap((s) => s.items),
  BOOKMARKS_DESTINATION,
];

export const NAV_BY_HREF: Record<string, NavDestination> = Object.fromEntries(
  NAV_DESTINATIONS.map((d) => [d.href, d]),
);
