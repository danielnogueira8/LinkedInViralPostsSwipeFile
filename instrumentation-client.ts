import * as Sentry from "@sentry/nextjs";
import { createSentryOptions } from "@/lib/sentry-config";

Sentry.init(createSentryOptions({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
  nodeEnv: process.env.NODE_ENV,
  release: process.env.NEXT_PUBLIC_SWIPEIN_DEPLOYMENT_ID,
}));

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
