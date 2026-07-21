export const SWIPEIN_SENTRY_DSN =
  "https://9abb522254a5a82d149025877ed661b7@o4511721831202817.ingest.de.sentry.io/4511721960702032";

// Keys whose VALUES must never reach Sentry. Secrets can ride into an event via
// captured request headers/config on a thrown fetch error, breadcrumbs, or an
// `extra` payload. We redact by key name, case-insensitively, anywhere in the
// event tree. First user-supplied secret: the LeadShark x-api-key (a leaked key
// can DM from the user's real LinkedIn account); the generic list also covers
// authorization headers and our own credential columns.
const REDACT_KEY_RE =
  /^(x-api-key|authorization|apikey|api_key|api-key|ciphertext|auth_tag|credential_encryption_key)$/i;

const REDACTED = "[redacted]";

// Depth-bounded, cycle-safe deep redaction. Mutates in place and returns the
// same reference. Bounded depth so a pathological event can't stall the hook.
function redactSecrets(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = redactSecrets(value[i], seen, depth + 1);
    }
    return value;
  }

  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (REDACT_KEY_RE.test(key)) {
      obj[key] = REDACTED;
    } else {
      obj[key] = redactSecrets(obj[key], seen, depth + 1);
    }
  }
  return obj;
}

// Sentry `beforeSend` hook — scrub secrets from the outgoing event. Exported so
// both the server and edge configs share one implementation.
export function scrubSentryEvent<T>(event: T): T {
  try {
    return redactSecrets(event) as T;
  } catch {
    // Never let scrubbing failure drop the event silently in a broken way —
    // but also never send an un-scrubbed event. Returning null tells Sentry to
    // discard it; the caller wires this return straight through `beforeSend`.
    return null as unknown as T;
  }
}

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
    // Strip secrets (x-api-key, authorization, credential columns) from every
    // event before it leaves the process. Runs regardless of `enabled`.
    beforeSend: scrubSentryEvent,
  };
}
