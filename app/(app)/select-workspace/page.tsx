import { SelectWorkspace } from "./select-workspace";

// Bounce page: the dashboard layout redirects here when the session's active
// organization isn't the user's own (stale/inherited org). setActive is
// client-side only, so this thin page calls it and routes back to /dashboard
// with the correct orgId on the session token.
export default async function SelectWorkspacePage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string }>;
}) {
  const { org } = await searchParams;
  return <SelectWorkspace orgId={org ?? null} />;
}
