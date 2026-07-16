export const SWIPEIN_SENTRY_DSN =
  "https://9abb522254a5a82d149025877ed661b7@o4511721831202817.ingest.de.sentry.io/4511721960702032";

export function createSentryOptions({
  dsn,
  environment,
  nodeEnv,
  release,
}: {
  dsn: string | undefined;
  environment: string | undefined;
  nodeEnv: string | undefined;
  release?: string | undefined;
}) {
  const resolvedEnvironment = environment ?? nodeEnv;
  const enabled = nodeEnv === "production" && resolvedEnvironment === "production";

  return {
    dsn: dsn ?? SWIPEIN_SENTRY_DSN,
    enabled,
    environment: resolvedEnvironment,
    ...(release
      ? {
          release,
          initialScope: { tags: { deployment_id: release } },
        }
      : {}),
    sendDefaultPii: false,
    tracesSampleRate: enabled ? 0.1 : 0,
  };
}
