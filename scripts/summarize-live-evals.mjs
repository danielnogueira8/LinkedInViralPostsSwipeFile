import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export function parseLiveContractReports(log) {
  return log
    .split(/\r?\n/)
    .filter((line) => line.includes("LIVE_CONTRACT "))
    .map((line) => JSON.parse(line.slice(line.indexOf("LIVE_CONTRACT ") + 14)));
}

export function buildLiveSummary(reports, commandOutcome, generatedAt = new Date().toISOString()) {
  const expectedContracts = 8;
  const status =
    reports.length === 0
      ? "no_data"
      : commandOutcome === "success" && reports.length === expectedContracts
        ? "passed"
        : "failed";
  return {
    generatedAt,
    status,
    commandOutcome,
    expectedContracts,
    observedContracts: reports.length,
    contracts: reports,
    totals: {
      contracts: reports.length,
      repetitions: reports.reduce((sum, report) => sum + report.completedRepetitions, 0),
      passes: reports.reduce((sum, report) => sum + report.passes, 0),
      actualCostUsd: reports.reduce((sum, report) => sum + report.costUsd, 0),
      reservedCostUsd: reports.reduce((sum, report) => sum + report.reservedCostUsd, 0),
    },
  };
}

if (process.argv[1]?.endsWith("summarize-live-evals.mjs")) {
  const logPath = process.argv[2] ?? "artifacts/live-evals.log";
  const commandOutcome = process.argv[3] ?? "unknown";
  const reports = parseLiveContractReports(existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
  const summary = buildLiveSummary(reports, commandOutcome);
  mkdirSync("artifacts", { recursive: true });
  writeFileSync("artifacts/live-eval-summary.json", `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Live trend summary: status=${summary.status}, ${summary.observedContracts}/${summary.expectedContracts} contracts, $${summary.totals.actualCostUsd.toFixed(4)} actual cost.`);
}
