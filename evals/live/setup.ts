// Vitest setup for the LIVE eval tier only. Loads .env.local so the real model
// (OPENROUTER_API_KEY) and the judge (ANTHROPIC_API_KEY) keys are available —
// vitest does NOT load it on its own, and Next's automatic .env loading doesn't
// apply under vitest.
//
// Only wired into the `test:evals:live` config, so the default stubbed suite
// (which needs no keys) never loads env and stays hermetic. Failing to load is
// non-fatal: the live suite skips cleanly when keys are absent.
import { config } from "dotenv";

try {
  config({ path: ".env.local" });
} catch {
  // No .env.local (e.g. CI provides env directly) — that's fine; the live
  // suite's shouldRunLiveEvals() gate skips if the keys still aren't present.
}
