export type ContractVerdict = { pass: boolean; reason: string; actualCostUsd: number };

export type LiveContract = {
  id: string;
  rule: string;
  model: string;
  parameters: Record<string, string | number | boolean>;
  repetitions: number;
  minimumPassRate: number;
  estimatedCostPerRunUsd: number;
};

export type ContractReport = {
  id: string;
  rule: string;
  model: string;
  parameters: Record<string, string | number | boolean>;
  repetitions: number;
  completedRepetitions: number;
  passes: number;
  passRate: number;
  minimumPassRate: number;
  costUsd: number;
  reservedCostUsd: number;
  failures: Array<{ attempt: number; reason: string }>;
};

export class LiveSpendBudget {
  private reservedUsd = 0;

  constructor(readonly ceilingUsd: number) {
    if (!Number.isFinite(ceilingUsd) || ceilingUsd <= 0) {
      throw new Error("LIVE_EVAL_SPEND_CEILING_USD must be a positive number");
    }
  }

  reserve(estimatedUsd: number): boolean {
    if (!Number.isFinite(estimatedUsd) || estimatedUsd <= 0) {
      throw new Error("Live evaluation cost estimate must be positive");
    }
    if (this.reservedUsd + estimatedUsd > this.ceilingUsd) return false;
    this.reservedUsd += estimatedUsd;
    return true;
  }

  get spentUsd() {
    return Number(this.reservedUsd.toFixed(6));
  }
}

export function liveSpendCeiling(): number {
  const value = Number(process.env.LIVE_EVAL_SPEND_CEILING_USD ?? "2.00");
  if (!Number.isFinite(value) || value <= 0) return 2;
  return value;
}

export function conservativeInputTokenBound(value: unknown): number {
  // A tokenizer token always consumes at least one UTF-8 byte. Byte length is
  // deliberately much more conservative than the usual chars/4 estimate and
  // cannot undercount even punctuation-heavy JSON, URLs, or non-ASCII text.
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export async function runLiveContract(
  contract: LiveContract,
  budget: LiveSpendBudget,
  probe: (attempt: number) => Promise<ContractVerdict>,
): Promise<ContractReport> {
  let passes = 0;
  let completedRepetitions = 0;
  let actualCostUsd = 0;
  const failures: Array<{ attempt: number; reason: string }> = [];
  const startCost = budget.spentUsd;

  for (let attempt = 1; attempt <= contract.repetitions; attempt++) {
    // Reserve the conservative model + judge estimate before either paid call.
    // If it does not fit, stop without issuing another request.
    if (!budget.reserve(contract.estimatedCostPerRunUsd)) break;
    completedRepetitions++;
    try {
      const verdict = await probe(attempt);
      if (!Number.isFinite(verdict.actualCostUsd) || verdict.actualCostUsd < 0) {
        throw new Error("provider returned invalid usage cost");
      }
      actualCostUsd += verdict.actualCostUsd;
      if (verdict.actualCostUsd > contract.estimatedCostPerRunUsd) {
        throw new Error(
          `provider cost exceeded reserved bound (${verdict.actualCostUsd.toFixed(6)} > ${contract.estimatedCostPerRunUsd.toFixed(6)})`,
        );
      }
      if (verdict.pass) passes++;
      else failures.push({ attempt, reason: sanitizeDiagnostic(verdict.reason) });
    } catch (error) {
      failures.push({
        attempt,
        reason: sanitizeDiagnostic(`probe threw: ${(error as Error).message}`),
      });
    }
  }

  return {
    id: contract.id,
    rule: contract.rule,
    model: contract.model,
    parameters: contract.parameters,
    repetitions: contract.repetitions,
    completedRepetitions,
    passes,
    passRate: completedRepetitions ? passes / completedRepetitions : 0,
    minimumPassRate: contract.minimumPassRate,
    costUsd: Number(actualCostUsd.toFixed(6)),
    reservedCostUsd: Number((budget.spentUsd - startCost).toFixed(6)),
    failures,
  };
}

export function contractPassed(report: ContractReport): boolean {
  return (
    report.completedRepetitions === report.repetitions &&
    report.passRate >= report.minimumPassRate
  );
}

export function safeReportLine(report: ContractReport): string {
  // Deliberately whitelist fields. Prompts, fixtures, and model output can
  // contain secrets and must never enter console logs or committed artifacts.
  return JSON.stringify({
    id: report.id,
    model: report.model,
    parameters: report.parameters,
    repetitions: report.repetitions,
    completedRepetitions: report.completedRepetitions,
    passes: report.passes,
    passRate: report.passRate,
    minimumPassRate: report.minimumPassRate,
    costUsd: report.costUsd,
    reservedCostUsd: report.reservedCostUsd,
    failureAttempts: report.failures.map((failure) => failure.attempt),
  });
}

function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/\b(?:sk-or-v1-|sk-ant-|sk-)[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, "Bearer [REDACTED]")
    .slice(0, 240);
}
