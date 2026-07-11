"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useOrganizationList } from "@clerk/nextjs";
import { Loader2 } from "lucide-react";

// Activates the user's own personal org, then returns to the dashboard.
// Rendered only when the dashboard layout detected a wrong/missing active org.
export function SelectWorkspace({ orgId }: { orgId: string }) {
  const router = useRouter();
  const { isLoaded, setActive } = useOrganizationList();
  const ran = useRef(false);

  useEffect(() => {
    if (!isLoaded || !setActive || ran.current) return;
    ran.current = true;
    (async () => {
      try {
        await setActive({ organization: orgId });
      } catch {
        // Membership race or stale id — fall through to the dashboard, which
        // re-runs the resolve logic.
      }
      router.replace("/dashboard");
    })();
  }, [isLoaded, setActive, orgId, router]);

  return (
    <div className="min-h-screen grid place-items-center bg-background">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Setting up your account…
      </div>
    </div>
  );
}
