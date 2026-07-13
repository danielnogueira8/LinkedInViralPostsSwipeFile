"use client";

import { usePathname } from "next/navigation";

// The main content wrapper. Most dashboard pages sit in a centered, padded
// column (max-w-[1400px] + generous padding) — that's the right frame for
// Posts, Bookmarks, Settings, etc. The Cowork chat (the /dashboard index) is
// different: it's a full-surface app view (its own three-column shell with an
// internal scroll), so the outer padding + max-width just box it into a floating
// "window" with dead space around it. This client wrapper drops the frame on the
// Cowork route ONLY, letting the chat fill the whole main area, while every other
// route keeps its comfortable centered layout.
export function DashboardContentFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // Exact match — only the Cowork index goes full-bleed. Sub-routes
  // (/dashboard/posts, /dashboard/creator-styles, …) keep the padded frame.
  const isCowork = pathname === "/dashboard";

  // Cowork fills the main area edge-to-edge (its own full app surface with an
  // internal scroll) — no panel, no padding, no max-width. Every other route
  // sits inside ONE white rounded panel inset on the gray background (the
  // reference workspace look), with the page's own centered padded column
  // inside it.
  if (isCowork) {
    return <div>{children}</div>;
  }

  return (
    <div
      data-slot="dashboard-scroll-container"
      className="lg:h-[calc(100vh-1.5rem)] lg:overflow-y-auto lg:m-3 lg:ml-0 lg:rounded-2xl lg:border lg:border-border lg:bg-card lg:shadow-soft"
    >
      <div className="max-w-[1400px] mx-auto px-4 sm:px-8 lg:px-10 py-4 sm:py-8 lg:py-10">
        {children}
      </div>
    </div>
  );
}
