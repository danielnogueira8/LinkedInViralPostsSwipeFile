import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

// ---------------------------------------------------------------------------
// Content Security Policy — keep this tight, especially img-src and connect-src.
//
// WHY this matters: the chat agent ingests untrusted scraped LinkedIn content
// (post bodies a creator authored, citation results, etc.). If we ever start
// rendering full markdown (images, links, HTML) in agent output, the browser
// will fetch image src URLs the model emits. Combined with the agent having
// access to other users' drafts (private data), an attacker-controlled image
// URL becomes an exfiltration channel — the "lethal trifecta" (Simon Willison):
//   private data + untrusted content + external comms → exfil.
// Bing Chat, Copilot Chat, Claude.ai, and NotebookLM all shipped this bug.
//
// The strict img-src + connect-src here makes that channel structurally
// unavailable. If you ever add a feature that needs a new external origin,
// add the SPECIFIC host here — don't widen the policy to '*'.
//
// Allowlist rationale:
//  - script-src: 'unsafe-inline' is required because Next.js still injects
//    inline scripts for hydration; replacing this with a nonce-based policy is
//    a separate project. Clerk + Vercel Live also need their hosts.
//  - img-src: data: (next/image blur placeholders), blob: (object URLs),
//    licdn.com (LinkedIn avatars + post media), img.clerk.com (user avatars),
//    Vercel preview hosts. NO wildcard — adding a new image source must be
//    deliberate.
//  - connect-src: self + Clerk + Supabase + Vercel insights/live. NO wildcard.
//  - frame-src: Clerk iframes (verification widgets), Vercel Live preview.
//  - object-src 'none' + base-uri 'self' + frame-ancestors 'none': defense
//    against framing/click-jacking and base-href injection.
// ---------------------------------------------------------------------------

const CSP_DIRECTIVES = {
  "default-src": ["'self'"],
  // 'unsafe-inline' for Next.js hydration scripts (see note above).
  // 'unsafe-eval' is unfortunately required by Clerk's frontend SDK.
  "script-src": [
    "'self'",
    "'unsafe-inline'",
    "'unsafe-eval'",
    "https://*.clerk.accounts.dev",
    "https://*.clerk.com",
    "https://challenges.cloudflare.com",
    "https://va.vercel-scripts.com",
    "https://vercel.live",
  ],
  // Inline styles are used by Tailwind v4 + next/font; safe enough.
  "style-src": ["'self'", "'unsafe-inline'"],
  // The exfil channel. Keep this list short and specific.
  "img-src": [
    "'self'",
    "data:",
    "blob:",
    "https://*.licdn.com",
    "https://img.clerk.com",
    "https://*.vercel.app",
    "https://vercel.live",
  ],
  "font-src": ["'self'", "data:"],
  // The other exfil channel. APIs the client legitimately calls.
  "connect-src": [
    "'self'",
    "https://*.clerk.accounts.dev",
    "https://*.clerk.com",
    "https://*.supabase.co",
    "wss://*.supabase.co",
    "https://va.vercel-scripts.com",
    "https://vitals.vercel-insights.com",
    "https://vercel.live",
    "wss://ws-us3.pusher.com",
  ],
  "frame-src": [
    "'self'",
    "https://*.clerk.accounts.dev",
    "https://*.clerk.com",
    "https://challenges.cloudflare.com",
    "https://vercel.live",
  ],
  "worker-src": ["'self'", "blob:"],
  // Defense against framing / click-jacking / base-href injection.
  "object-src": ["'none'"],
  "base-uri": ["'self'"],
  "frame-ancestors": ["'none'"],
  "form-action": ["'self'"],
} as const;

const CSP_HEADER = Object.entries(CSP_DIRECTIVES)
  .map(([directive, sources]) => `${directive} ${sources.join(" ")}`)
  .join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP_HEADER },
  // Belt-and-suspenders against framing (CSP frame-ancestors covers modern
  // browsers; this is the legacy header).
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
];

const nextConfig: NextConfig = {
  env: {
    // VERCEL_ENV is server-only by default. Expose only its non-sensitive
    // deployment label so preview events do not get grouped as production.
    NEXT_PUBLIC_VERCEL_ENV: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    // Tag client-side recoverable errors (including hydration mismatches) with
    // the exact deployment that produced them. This lets us distinguish a real
    // render bug from a one-off rolling-deploy/version-skew event.
    NEXT_PUBLIC_SWIPEIN_DEPLOYMENT_ID:
      process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.NEXT_DEPLOYMENT_ID,
  },
  turbopack: {
    root: __dirname,
  },
  images: {
    qualities: [70, 75],
    formats: ["image/webp"],
    remotePatterns: [
      { protocol: "https", hostname: "media.licdn.com" },
      { protocol: "https", hostname: "*.licdn.com" },
    ],
  },
  async headers() {
    return [
      // Apply to everything except Next.js internals (which need their own
      // loading paths without policy interference).
      {
        source: "/((?!_next/static|_next/image|favicon.ico).*)",
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: "swipein",
  project: "swipein-prod",
  authToken: process.env.SENTRY_AUTH_TOKEN,

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  tunnelRoute: "/monitoring",
  sourcemaps: {
    disable: !process.env.SENTRY_AUTH_TOKEN,
    deleteSourcemapsAfterUpload: true,
  },
});
