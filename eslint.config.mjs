import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Local agent checkouts and generated test artifacts are not owned source.
    ".claude/**",
    ".worktrees/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
  ]),
  // ---------------------------------------------------------------------------
  // Guardrail: cost-logging must always be AWAITED, never fire-and-forget.
  // logOpenRouterUsage writes the spend that the monthly cost cap reads; a
  // `void logOpenRouterUsage(...)` can be dropped when the serverless instance
  // freezes / a concurrent turn-claim races the insert, under-counting spend.
  // Two production bugs came from exactly this (PRs #409, #390). The function
  // has its own try/catch and never throws, so `await` is always safe. This
  // string-free AST rule (no type-info needed) makes a future `void` a CI
  // failure with a pointer to the fix. (Background-task callers: await it too —
  // the cost is one cheap insert; consistency beats a micro-optimization.)
  {
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            'UnaryExpression[operator="void"] > CallExpression > Identifier.callee[name="logOpenRouterUsage"]',
          message:
            "Don't fire-and-forget logOpenRouterUsage — `await` it so the cost is committed before the turn/response ends (it never throws). See PRs #409/#390.",
        },
      ],
    },
  },
]);

export default eslintConfig;
