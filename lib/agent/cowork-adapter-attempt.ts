import {
  AdapterCircuitOpenError,
  classifyAdapterFailure,
  runHealthyAdapter,
  type AdapterHealthRegistry,
} from "@/lib/agent/adapter-health";
import type { CoworkTurnTelemetry } from "@/lib/agent/cowork-telemetry";
import type { Usage } from "@/lib/openrouter";
import { shouldUseAnthropic } from "@/lib/anthropic";

// Attribute a per-attempt telemetry record to whoever actually served the model,
// matching the authoritative usage_events.provider label (logOpenRouterUsage).
// shouldUseAnthropic encodes the flag + model check, so a claude-* attempt run
// while AI_PROVIDER=anthropic is "anthropic"; everything else is "openrouter".
function providerFor(model: string): "anthropic" | "openrouter" {
  return shouldUseAnthropic(model) ? "anthropic" : "openrouter";
}

export function providerModelAttribution(
  requestedModel: string,
  reportedModel: string | undefined,
): { model: string; metadata: Record<string, string> } {
  const model = reportedModel?.trim() || requestedModel;
  return {
    model,
    metadata: model !== requestedModel ? { requested_model: requestedModel } : {},
  };
}

export type CoworkAdapterAttemptInput<TResponse, TValue> = {
  registry: AdapterHealthRegistry;
  adapterKey: string;
  signal?: AbortSignal;
  call: () => Promise<TResponse>;
  validate: (response: TResponse) => TValue | Promise<TValue>;
  persistUsage: (response: TResponse) => Promise<void>;
  usage: (response: TResponse) => Usage | undefined;
  responseModel?: (response: TResponse) => string | undefined;
  telemetry?: CoworkTurnTelemetry;
  stage: string;
  attempt: number;
  model: string;
  fallbackReason?: string;
  rejectedReasonCode: string;
  cancellationReason?: () => "cancelled" | "deadline";
  // When true, a validate() throw on this attempt is reported to the caller
  // (retry/fallback logic still runs) but does NOT count as a failure sample
  // on the adapter's health circuit. Use only where a malformed tool-call
  // response is known to reflect this one call's own flakiness rather than
  // provider-level unreliability worth tracking — e.g. a reviewer whose
  // schema-invalid output must not degrade the shared circuit for unrelated
  // turns. Genuine transport failures (timeouts, 5xx, rate limits) still
  // count toward the circuit even when this is set; only the validate()
  // throw path is affected. Defaults to false (validate throws behave as
  // today: they degrade the circuit like transport failures).
  validationFailureIsHealthNeutral?: boolean;
};

export type CoworkAdapterAttemptResult<TResponse, TValue> = {
  response: TResponse;
  value: TValue;
  latencyMs: number;
};

/**
 * Own one paid adapter attempt from permit acquisition through validation,
 * authoritative usage persistence, and safe telemetry. Validation is inside
 * the health boundary so malformed model output degrades the circuit just like
 * transport failures, UNLESS the caller opts a specific attempt into
 * validationFailureIsHealthNeutral (see that field's docs) — that is the one
 * exception, for callers where a validate() throw is known to reflect this
 * one call's own flakiness rather than provider-level unreliability. Usage is
 * persisted exactly once whenever a provider returned a response, including
 * rejected responses.
 */
export async function runCoworkAdapterAttempt<TResponse, TValue>(
  input: CoworkAdapterAttemptInput<TResponse, TValue>,
): Promise<CoworkAdapterAttemptResult<TResponse, TValue>> {
  const startedAt = Date.now();
  let response: TResponse | null = null;
  let result: { value: TValue; latencyMs: number };
  const observedModel = () =>
    providerModelAttribution(
      input.model,
      response === null ? undefined : input.responseModel?.(response),
    ).model;
  // Identifies the exact error instance thrown by validate() on this attempt
  // (as opposed to an error thrown by call() itself, e.g. a real transport
  // failure) so isHealthNeutral below can be precise rather than pattern
  // matching on the error's name/shape.
  const healthNeutralErrors = new WeakSet<object>();

  try {
    result = await runHealthyAdapter({
      registry: input.registry,
      key: input.adapterKey,
      signal: input.signal,
      call: async () => {
        response = await input.call();
        try {
          return await input.validate(response);
        } catch (cause) {
          const invalid = new Error("Adapter response validation failed.", {
            cause,
          });
          invalid.name = "InvalidAdapterResponseError";
          if (input.validationFailureIsHealthNeutral) {
            healthNeutralErrors.add(invalid);
          }
          throw invalid;
        }
      },
      isHealthNeutral: (error) =>
        typeof error === "object" &&
        error !== null &&
        healthNeutralErrors.has(error),
    });
  } catch (error) {
    input.telemetry?.recordAttempt({
      stage: input.stage,
      attempt: input.attempt,
      model: observedModel(),
      requestedModel: input.model,
      provider: providerFor(observedModel()),
      outcome: response
        ? "rejected"
        : error instanceof AdapterCircuitOpenError
          ? "skipped"
          : "failed",
      reasonCode: response
        ? input.rejectedReasonCode
        : input.signal?.aborted
          ? (input.cancellationReason?.() ?? "cancelled")
          : error instanceof AdapterCircuitOpenError
            ? "circuit_open"
            : classifyAdapterFailure(error),
      ...(input.fallbackReason
        ? { fallbackReason: input.fallbackReason }
        : {}),
      latencyMs: Date.now() - startedAt,
      usage: response ? input.usage(response) : undefined,
    });
    // Record the paid provider response before authoritative usage persistence:
    // if the cost ledger fails closed, the operational attempt must still be
    // visible even though the user turn is correctly aborted.
    if (response) await input.persistUsage(response);
    throw error;
  }

  if (response === null) {
    throw new Error("Adapter attempt completed without a response.");
  }
  input.telemetry?.recordAttempt({
    stage: input.stage,
    attempt: input.attempt,
    model: observedModel(),
    requestedModel: input.model,
    provider: providerFor(observedModel()),
    outcome: "accepted",
    ...(input.fallbackReason ? { fallbackReason: input.fallbackReason } : {}),
    latencyMs: result.latencyMs,
    usage: input.usage(response),
  });
  await input.persistUsage(response);
  return { response, value: result.value, latencyMs: result.latencyMs };
}
