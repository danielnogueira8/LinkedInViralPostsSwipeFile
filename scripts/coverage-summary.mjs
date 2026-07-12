import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function formatCoverageSummary(summary) {
  const total = summary.total;
  return [
    "Deterministic coverage baseline",
    `Statements: ${total.statements.pct}%`,
    `Branches: ${total.branches.pct}%`,
    `Functions: ${total.functions.pct}%`,
    `Lines: ${total.lines.pct}%`,
  ].join("\n");
}

function run() {
  const vitest = spawnSync(
    process.platform === "win32" ? "node_modules/.bin/vitest.cmd" : "node_modules/.bin/vitest",
    ["run", "--coverage", "--coverage.reporter=json-summary", "--reporter=dot"],
    { stdio: "inherit" },
  );
  if (vitest.status !== 0) process.exit(vitest.status ?? 1);

  const summary = JSON.parse(
    readFileSync("coverage/coverage-summary.json", "utf8"),
  );
  process.stdout.write(`${formatCoverageSummary(summary)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
