import { SelectWorkspace } from "./select-workspace";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { resolvePersonalWorkspaceForUser } from "@/lib/personal-workspace";

// Bounce page: the dashboard layout redirects here when the session's active
// organization isn't the user's own (stale/inherited org). setActive is
// client-side only, so this thin page calls it and routes back to /dashboard
// with the correct orgId on the session token.
export default async function SelectWorkspacePage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");
  const workspaceId = await resolvePersonalWorkspaceForUser(userId);
  return <SelectWorkspace orgId={workspaceId} />;
}
