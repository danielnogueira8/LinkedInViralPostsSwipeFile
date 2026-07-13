import { readFileSync } from "node:fs";

export function checkFocusedCoverage(summary, policy) {
  const failures = [];
  for (const policyModule of policy.modules) {
    const entry = Object.entries(summary).find(([path]) => path.endsWith(`/${policyModule.path}`))?.[1];
    if (!entry) {
      failures.push(`${policyModule.path}: missing from coverage output`);
      continue;
    }
    for (const metric of ["statements", "branches", "functions", "lines"]) {
      const actual = entry[metric]?.pct ?? 0;
      const required = policyModule[metric];
      if (actual < required) failures.push(`${policyModule.path} ${metric}: ${actual}% < ${required}%`);
    }
  }
  return failures;
}

if (process.argv[1]?.endsWith("check-focused-coverage.mjs")) {
  const summary = JSON.parse(readFileSync("coverage/coverage-summary.json", "utf8"));
  const policy = JSON.parse(readFileSync("docs/testing/focused-coverage.json", "utf8"));
  const failures = checkFocusedCoverage(summary, policy);
  if (failures.length) {
    console.error(`Focused coverage gate failed:\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
  console.log(`Focused coverage gate passed for ${policy.modules.length} critical modules.`);
}
