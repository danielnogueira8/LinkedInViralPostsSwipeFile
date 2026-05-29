"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";

// Catches any error thrown while rendering a dashboard page (server or
// client). Without this, a thrown error — e.g. a transient Supabase read
// failure like the categories load that now throws on persistent failure —
// would fall through to Next's raw, unstyled error screen. This keeps the
// failure inside the app's chrome and gives the user a one-click recovery
// (`reset()` re-renders the segment, re-running the failed server fetch).
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface for observability; the digest correlates client+server logs.
    console.error("Dashboard segment error:", error);
  }, [error]);

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 text-center">
      <div className="space-y-1.5">
        <h2 className="text-xl font-display tracking-tight">Something went wrong</h2>
        <p className="text-sm text-muted-foreground max-w-sm">
          We couldn&apos;t load this page. This is usually a brief hiccup —
          try again, and if it keeps happening, refresh the app.
        </p>
      </div>
      <Button onClick={reset} variant="outline" size="sm">
        <RefreshCw className="h-3.5 w-3.5" />
        Try again
      </Button>
    </div>
  );
}
