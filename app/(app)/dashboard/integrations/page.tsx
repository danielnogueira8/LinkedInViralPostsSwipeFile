import Link from "next/link";
import { PageHeader, PageShell } from "@/components/app-surface";
import { SurfaceHelp } from "@/components/surface-help";
import { getWorkspaceId } from "@/lib/workspace";
import {
  getCredentialSafe,
  type LeadSharkCredentialSafe,
} from "@/lib/leadshark-credentials";
import { LeadSharkCard } from "./leadshark-card";

export const dynamic = "force-dynamic";

// Integrations hub. Home for third-party tools the user connects with their own
// credentials. First tenant: LeadShark (comment-triggered auto-DM). The
// LinkedIn/Zernio publishing connection deliberately stays in Settings for now
// (moving it would touch a working OAuth ?returnTo flow for no functional gain);
// a pointer below keeps users from hunting for it.
export default async function IntegrationsPage() {
  const workspaceId = await getWorkspaceId();

  // Signed-out safety: render the not-connected shape rather than throwing.
  const initial: LeadSharkCredentialSafe = workspaceId
    ? await getCredentialSafe(workspaceId)
    : {
        connected: false,
        status: "revoked",
        keyHint: null,
        lastVerifiedAt: null,
        lastError: null,
      };

  return (
    <PageShell width="wide">
      <PageHeader
        title="Integrations"
        meta={
          <SurfaceHelp title="Connect third-party tools with your own account. LeadShark auto-DMs people who comment on your lead-magnet posts." />
        }
        description="Connect third-party tools to SwipeIn. These use your own account and credentials."
      />

      <div className="space-y-4">
        <LeadSharkCard initial={initial} />

        <p className="max-w-3xl text-xs text-muted-foreground">
          Looking for your LinkedIn publishing connection? That lives in{" "}
          <Link href="/dashboard/settings" className="underline underline-offset-2">
            Settings → Publishing
          </Link>
          .
        </p>
      </div>
    </PageShell>
  );
}
