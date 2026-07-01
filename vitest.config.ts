import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Vitest config — runs the eval suite (deterministic loop tests against a
// stubbed model). Live-model evals are a separate tier, gated on an env flag.
//
// We resolve "@/*" → project root manually (instead of vite-tsconfig-paths,
// which is ESM-only and conflicts with this project's CJS config).
const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": projectRoot,
    },
  },
  test: {
    include: ["evals/**/*.test.ts"],
    // The live-model prompt evals (*.live.test.ts) are a SEPARATE, opt-in tier
    // — they hit real APIs and cost tokens. Excluded here so the default
    // `npm run test:evals` stays hermetic, free, and fast. Run them with
    // `npm run test:evals:live` (uses vitest.live.config.ts).
    exclude: ["**/node_modules/**", "evals/**/*.live.test.ts"],
    // Keep tests Node-only — no JSDOM. The eval suite exercises the agent
    // loop / tools / openrouter parser, none of which need a browser env.
    environment: "node",
    // Generous timeout. Some scenarios run multi-round simulated agent loops,
    // and openrouter-retry's "persistent failure" cases drive fetchWithRetry
    // through its REAL setTimeout backoff (300ms → 600ms → up to 4000ms). Under
    // parallel workers those real sleeps compete for CPU with the loop sims and,
    // on an unlucky schedule, pushed a neighbouring test past the old 10s limit
    // — the source of the suite's intermittent flakiness. 30s gives comfortable
    // headroom without masking a genuine hang (a real infinite loop still trips
    // it). We can't shrink the retry delays via env (the retry-DECISION tests
    // assert exact jitter bands sized to the 300ms base), so the timeout is the
    // safe lever here.
    testTimeout: 30_000,
  },
});
