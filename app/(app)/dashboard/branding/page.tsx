import { redirect } from "next/navigation";

// Branding has been removed from the product (no nav entry). Direct visits to
// /dashboard/branding redirect to the dashboard. The original UI (manager,
// loading, and the disabled page) was deleted — restore it from git history if
// the feature ever returns. The /api/branding routes and legacy `clients` data
// remain on disk for reversibility, but brand tools are not exposed to agents.
export default function BrandingDisabled() {
  redirect("/dashboard");
}
