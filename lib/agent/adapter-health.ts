export type AdapterCircuitState = "closed" | "open" | "half_open";
export type AdapterFailureKind =
  | "timeout"
  | "rate_limit"
  | "provider_5xx"
  | "invalid_response"
  | "unknown";

export type AdapterHealthConfig = {
  windowSize: number;
  minimumSamples: number;
  failureRateToOpen: number;
  slowRateToOpen: number;
  slowLatencyMs: number;
  openCooldownMs: number;
  halfOpenSuccessesToClose: number;
  now: () => number;
};

type HealthSample = { failed: boolean; slow: boolean };
type AdapterHealthState = {
  state: AdapterCircuitState;
  epoch: number;
  samples: HealthSample[];
  openUntil: number;
  halfOpenInFlight: boolean;
  halfOpenSuccesses: number;
};

export type AdapterHealthPermit = {
  allowed: boolean;
  state: AdapterCircuitState;
  epoch: number;
};

const DEFAULT_CONFIG: AdapterHealthConfig = {
  windowSize: 20,
  minimumSamples: 5,
  failureRateToOpen: 0.5,
  slowRateToOpen: 0.6,
  slowLatencyMs: 20_000,
  openCooldownMs: 30_000,
  halfOpenSuccessesToClose: 2,
  now: () => Date.now(),
};

function boundedRate(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function statusCode(error: unknown): number | null {
  const candidate = error as { status?: unknown; code?: unknown } | null;
  for (const value of [candidate?.status, candidate?.code]) {
    const numeric = Number(value);
    if (Number.isInteger(numeric) && numeric >= 100 && numeric <= 599) {
      return numeric;
    }
  }
  if (error instanceof Error) {
    const match = /(?:^|\s)(429|5\d\d)(?:\s|$)/.exec(error.message);
    if (match) return Number(match[1]);
  }
  return null;
}

export function classifyAdapterFailure(error: unknown): AdapterFailureKind {
  const status = statusCode(error);
  if (status === 429) return "rate_limit";
  if (status !== null && status >= 500) return "provider_5xx";
  const name = error instanceof Error ? error.name : "";
  if (/timeout/i.test(name)) return "timeout";
  if (
    error instanceof SyntaxError ||
    /(?:invalid.*response|zod)/i.test(name)
  ) {
    return "invalid_response";
  }
  return "unknown";
}

export class AdapterCircuitOpenError extends Error {
  readonly code = "adapter_circuit_open";

  constructor(readonly adapterKey: string) {
    super("The selected adapter is temporarily unavailable.");
    this.name = "AdapterCircuitOpenError";
  }
}

export class AdapterHealthRegistry {
  private readonly config: AdapterHealthConfig;
  private readonly states = new Map<string, AdapterHealthState>();

  constructor(config: Partial<AdapterHealthConfig> = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      windowSize: Math.max(1, Math.floor(config.windowSize ?? DEFAULT_CONFIG.windowSize)),
      minimumSamples: Math.max(
        1,
        Math.floor(config.minimumSamples ?? DEFAULT_CONFIG.minimumSamples),
      ),
      failureRateToOpen: boundedRate(
        config.failureRateToOpen ?? DEFAULT_CONFIG.failureRateToOpen,
      ),
      slowRateToOpen: boundedRate(
        config.slowRateToOpen ?? DEFAULT_CONFIG.slowRateToOpen,
      ),
      slowLatencyMs: Math.max(
        1,
        config.slowLatencyMs ?? DEFAULT_CONFIG.slowLatencyMs,
      ),
      openCooldownMs: Math.max(
        1,
        config.openCooldownMs ?? DEFAULT_CONFIG.openCooldownMs,
      ),
      halfOpenSuccessesToClose: Math.max(
        1,
        Math.floor(
          config.halfOpenSuccessesToClose ??
            DEFAULT_CONFIG.halfOpenSuccessesToClose,
        ),
      ),
    };
  }

  private value(key: string): AdapterHealthState {
    const current = this.states.get(key);
    if (current) return current;
    const created: AdapterHealthState = {
      state: "closed",
      epoch: 0,
      samples: [],
      openUntil: 0,
      halfOpenInFlight: false,
      halfOpenSuccesses: 0,
    };
    this.states.set(key, created);
    return created;
  }

  acquire(key: string): AdapterHealthPermit {
    const health = this.value(key);
    if (health.state === "open") {
      if (this.config.now() < health.openUntil) {
        return { allowed: false, state: "open", epoch: health.epoch };
      }
      health.state = "half_open";
      health.halfOpenInFlight = false;
      health.halfOpenSuccesses = 0;
    }
    if (health.state === "half_open") {
      if (health.halfOpenInFlight) {
        return { allowed: false, state: "half_open", epoch: health.epoch };
      }
      health.halfOpenInFlight = true;
    }
    return { allowed: true, state: health.state, epoch: health.epoch };
  }

  recordSuccess(
    key: string,
    latencyMs: number,
    permit?: AdapterHealthPermit,
  ): void {
    const health = this.value(key);
    if (permit && permit.epoch !== health.epoch) return;
    if (health.state === "half_open") {
      health.halfOpenInFlight = false;
      if (latencyMs >= this.config.slowLatencyMs) {
        this.open(health);
        return;
      }
      health.halfOpenSuccesses += 1;
      if (health.halfOpenSuccesses >= this.config.halfOpenSuccessesToClose) {
        health.state = "closed";
        health.epoch += 1;
        health.samples = [];
        health.openUntil = 0;
        health.halfOpenSuccesses = 0;
      }
      return;
    }
    this.sample(health, { failed: false, slow: latencyMs >= this.config.slowLatencyMs });
  }

  recordFailure(
    key: string,
    _kind: AdapterFailureKind,
    latencyMs: number,
    permit?: AdapterHealthPermit,
  ): void {
    const health = this.value(key);
    if (permit && permit.epoch !== health.epoch) return;
    if (health.state === "half_open") {
      health.halfOpenInFlight = false;
      this.open(health);
      return;
    }
    this.sample(health, {
      failed: true,
      slow: latencyMs >= this.config.slowLatencyMs,
    });
  }

  release(key: string, permit?: AdapterHealthPermit): void {
    const health = this.value(key);
    if (permit && permit.epoch !== health.epoch) return;
    if (health.state === "half_open") health.halfOpenInFlight = false;
  }

  snapshot(key: string): {
    state: AdapterCircuitState;
    samples: number;
    failureRate: number;
    slowRate: number;
    openUntil: number | null;
  } {
    const health = this.value(key);
    const count = health.samples.length;
    return {
      state: health.state,
      samples: count,
      failureRate:
        count > 0
          ? health.samples.filter((sample) => sample.failed).length / count
          : 0,
      slowRate:
        count > 0
          ? health.samples.filter((sample) => sample.slow).length / count
          : 0,
      openUntil: health.state === "open" ? health.openUntil : null,
    };
  }

  private sample(health: AdapterHealthState, sample: HealthSample): void {
    health.samples.push(sample);
    if (health.samples.length > this.config.windowSize) health.samples.shift();
    if (health.samples.length < this.config.minimumSamples) return;
    const failures = health.samples.filter((value) => value.failed).length;
    const slow = health.samples.filter((value) => value.slow).length;
    if (
      failures / health.samples.length >= this.config.failureRateToOpen ||
      slow / health.samples.length >= this.config.slowRateToOpen
    ) {
      this.open(health);
    }
  }

  private open(health: AdapterHealthState): void {
    health.state = "open";
    health.epoch += 1;
    health.openUntil = this.config.now() + this.config.openCooldownMs;
    health.halfOpenInFlight = false;
    health.halfOpenSuccesses = 0;
  }
}

export const coworkAdapterHealth = new AdapterHealthRegistry();

export async function runHealthyAdapter<T>(input: {
  registry: AdapterHealthRegistry;
  key: string;
  signal?: AbortSignal;
  call: () => Promise<T>;
  // Lets a caller mark a specific caught error as health-neutral: the permit
  // is released (so a half-open probe never gets stuck) but no failure sample
  // is recorded, so this attempt does not push the circuit toward opening.
  // Used to keep a validate() throw that only proves a malformed response
  // (not a transport problem) from degrading the same circuit as real
  // provider failures. Defaults to treating every caught error as a failure.
  isHealthNeutral?: (error: unknown) => boolean;
}): Promise<{ value: T; latencyMs: number }> {
  input.signal?.throwIfAborted();
  const permit = input.registry.acquire(input.key);
  if (!permit.allowed) throw new AdapterCircuitOpenError(input.key);
  if (input.signal?.aborted) {
    input.registry.release(input.key, permit);
    input.signal.throwIfAborted();
  }
  const startedAt = Date.now();
  try {
    const value = await input.call();
    const latencyMs = Date.now() - startedAt;
    if (input.signal?.aborted) {
      input.registry.release(input.key, permit);
    } else {
      input.registry.recordSuccess(input.key, latencyMs, permit);
    }
    return { value, latencyMs };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    if (input.signal?.aborted || input.isHealthNeutral?.(error)) {
      input.registry.release(input.key, permit);
    } else {
      input.registry.recordFailure(
        input.key,
        classifyAdapterFailure(error),
        latencyMs,
        permit,
      );
    }
    throw error;
  }
}
