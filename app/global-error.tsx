"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

// Root-level error boundary. Segment boundaries (app/(app)/error.tsx and
// app/(app)/dashboard/error.tsx) catch errors WITHIN the authenticated shell,
// but an error thrown by the ROOT layout itself — a Clerk provider failure, a
// top-level data read, a bad env at boot — escapes those and would otherwise
// render Next's raw, unstyled error page. This boundary replaces that with a
// clean, self-contained fallback + a refresh.
//
// A global-error boundary must render its OWN <html>/<body> (it replaces the
// root layout), and it can't assume the app's CSS pipeline loaded — the thing
// that broke might BE the layout/styles. So everything here is inline-styled and
// dependency-free, guaranteed to render no matter what failed above it.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
    console.error("Global error:", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          background: "#faf9f7",
          color: "#1c1917",
          padding: "24px",
        }}
      >
        <div style={{ maxWidth: 420, textAlign: "center" }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: "0 0 8px" }}>
            Something went wrong
          </h1>
          <p style={{ fontSize: 14, lineHeight: 1.5, color: "#57534e", margin: "0 0 20px" }}>
            We hit a problem loading the app. This is usually temporary — please
            refresh and try again. If it keeps happening, reach out to support.
          </p>
          <button
            type="button"
            onClick={() => {
              // reset() retries the failed render; if the root itself is wedged,
              // a hard reload is the reliable escape, so do both.
              reset();
              if (typeof window !== "undefined") window.location.reload();
            }}
            style={{
              appearance: "none",
              border: "none",
              borderRadius: 8,
              background: "#c2410c",
              color: "#fff",
              fontSize: 14,
              fontWeight: 600,
              padding: "10px 20px",
              cursor: "pointer",
            }}
          >
            Refresh
          </button>
        </div>
      </body>
    </html>
  );
}
