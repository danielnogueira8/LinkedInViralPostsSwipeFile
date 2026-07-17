import {
  AdapterCircuitOpenError,
  classifyAdapterFailure,
  runHealthyAdapter,
  type AdapterHealthRegistry,
} from "@/lib/agent/adapter-health";
import type { CoworkTurnTelemetry } from "@/lib/agent/cowork-telemetry";
import type { Usage } from "@/lib/openrouter";

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
 * transport failures. Usage is persisted exactly once whenever a provider
 * returned a response, including rejected responses.
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
          throw invalid;
        }
      },
    });
  } catch (error) {
    input.telemetry?.recordAttempt({
      stage: input.stage,
      attempt: input.attempt,
      model: observedModel(),
      requestedModel: input.model,
      provider: "openrouter",
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
    provider: "openrouter",
    outcome: "accepted",
    ...(input.fallbackReason ? { fallbackReason: input.fallbackReason } : {}),
    latencyMs: result.latencyMs,
    usage: input.usage(response),
  });
  await input.persistUsage(response);
  return { response, value: result.value, latencyMs: result.latencyMs };
}
