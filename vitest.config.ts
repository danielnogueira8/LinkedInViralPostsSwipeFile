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
    // Keep tests Node-only — no JSDOM. The eval suite exercises the agent
    // loop / tools / openrouter parser, none of which need a browser env.
    environment: "node",
    // Long timeout because some scenarios run multi-round simulated loops.
    testTimeout: 10_000,
  },
});
