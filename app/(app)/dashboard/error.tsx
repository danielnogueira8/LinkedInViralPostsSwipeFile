"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";

// Catches any error thrown while rendering a dashboard page (server or
// client). Without this, a thrown error — e.g. a transient Supabase read
// failure like the categories load that now throws on persistent failure —
// would fall through to Next's raw, unstyled error screen. This keeps the
// failure inside the app's chrome and gives the user a one-click recovery.
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();

  useEffect(() => {
    // Surface for observability; the digest correlates client+server logs.
    console.error("Dashboard segment error:", error);
  }, [error]);

  // "Try again" must recover from a server-side read that threw — not just a
  // client render error. reset() alone re-renders the segment within the SAME
  // server request, so any value memoized by React cache() during that request
  // (e.g. a thrown error from trackedAccountIds) is replayed and the retry
  // sticks — which is exactly why a transient blip used to need a full browser
  // refresh. router.refresh() re-runs the server components in a FRESH request
  // (new cache() scope), so the failed read actually re-executes; we then
  // reset() to clear the client-side error boundary state. Together they make
  // one click behave like the manual refresh, without a full page reload.
  function retry() {
    router.refresh();
    reset();
  }

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 text-center">
      <div className="space-y-1.5">
        <h2 className="text-xl font-display tracking-tight">Something went wrong</h2>
        <p className="text-sm text-muted-foreground max-w-sm">
          We couldn&apos;t load this page. This is usually a brief hiccup —
          try again, and if it keeps happening, refresh the app.
        </p>
      </div>
      <Button onClick={retry} variant="outline" size="sm">
        <RefreshCw className="h-3.5 w-3.5" />
        Try again
      </Button>
    </div>
  );
}
