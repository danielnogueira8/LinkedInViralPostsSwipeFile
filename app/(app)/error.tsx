"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";

// Segment-level error boundary for the authenticated app shell. The dashboard
// has its own boundary (app/(app)/dashboard/error.tsx); this one covers the
// sibling segments under (app) — e.g. the onboarding /welcome wizard — so a
// thrown render error (like a transient Supabase read that now throws instead
// of silently rendering an empty category picker) lands in styled chrome with
// a one-click retry instead of Next's raw error screen.
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();

  useEffect(() => {
    console.error("App segment error:", error);
  }, [error]);

  // router.refresh() re-runs the server components in a fresh request (new
  // React cache() scope) so a server read that threw actually re-executes;
  // reset() then clears the boundary. reset() alone replays the same cached
  // throw, which is why a transient blip used to need a full browser refresh.
  // See app/(app)/dashboard/error.tsx for the full rationale.
  function retry() {
    router.refresh();
    reset();
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
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
