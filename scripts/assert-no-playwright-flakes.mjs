import { readFileSync } from "node:fs";

export function flakyTests(report) {
  const flaky = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const statuses = (test.results ?? []).map((result) => result.status);
        if (statuses.length > 1 && statuses.at(-1) === "passed") {
          flaky.push(`${spec.file ?? "unknown"}: ${spec.title}`);
        }
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return flaky;
}

if (process.argv[1]?.endsWith("assert-no-playwright-flakes.mjs")) {
  const report = JSON.parse(readFileSync("e2e/.report/results.json", "utf8"));
  const flaky = flakyTests(report);
  if (flaky.length) {
    console.error(`Playwright flake policy failed (failed once, passed on retry):\n- ${flaky.join("\n- ")}`);
    process.exit(1);
  }
  console.log("Playwright flake policy passed: no retry-dependent tests.");
}
