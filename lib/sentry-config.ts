export const SWIPEIN_SENTRY_DSN =
  "https://9abb522254a5a82d149025877ed661b7@o4511721831202817.ingest.de.sentry.io/4511721960702032";

export function createSentryOptions({
  dsn,
  environment,
  nodeEnv,
}: {
  dsn: string | undefined;
  environment: string | undefined;
  nodeEnv: string | undefined;
}) {
  return {
    dsn: dsn ?? SWIPEIN_SENTRY_DSN,
    enabled: true,
    environment: environment ?? nodeEnv,
    sendDefaultPii: false,
    tracesSampleRate: nodeEnv === "production" ? 0.1 : 1,
  };
}
