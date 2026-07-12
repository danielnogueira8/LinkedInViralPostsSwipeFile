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
    dsn,
    enabled: Boolean(dsn),
    environment: environment ?? nodeEnv,
    sendDefaultPii: false,
    tracesSampleRate: nodeEnv === "production" ? 0.1 : 1,
  };
}
