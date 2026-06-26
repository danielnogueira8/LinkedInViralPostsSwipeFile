import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Vitest config for the LIVE-MODEL prompt-eval tier (Tier 3).
//
// These tests hit the real chat model (GLM via OpenRouter) and a real LLM judge
// (Claude via the Anthropic SDK), so they're opt-in and run separately from the
// default hermetic suite. Run with `npm run test:evals:live` — which sets
// RUN_LIVE_EVALS=1; the suite still skips cleanly if the API keys are absent.
const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": projectRoot,
    },
  },
  test: {
    // ONLY the live tests — the default config excludes these.
    include: ["evals/**/*.live.test.ts"],
    // Load .env.local so the model + judge keys are available (vitest doesn't
    // load it automatically).
    setupFiles: ["evals/live/setup.ts"],
    environment: "node",
    // Real model + judge round-trips per case, with the agent loop running
    // multiple rounds — generous timeout, and no parallelism so we don't fan
    // out concurrent paid calls.
    testTimeout: 120_000,
    fileParallelism: false,
  },
});
