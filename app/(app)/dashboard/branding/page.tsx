import { redirect } from "next/navigation";

// Branding has been removed from the product (no nav entry). This page is
// disabled rather than deleted: any direct visit to /dashboard/branding
// redirects to the dashboard, and the full original implementation is preserved
// next to this file as `page.tsx.disabled` (plus manager.tsx, loading.tsx, and
// the /api/branding routes, all kept on disk). To re-enable: restore
// page.tsx.disabled over this file and re-add the nav links in nav.tsx /
// mobile-nav.tsx. The underlying `clients` data and the list_brands / get_brand
// MCP tools are untouched and still work.
export default function BrandingDisabled() {
  redirect("/dashboard");
}
