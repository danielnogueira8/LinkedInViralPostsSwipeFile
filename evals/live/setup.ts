// Vitest setup for the LIVE eval tier only. Loads .env.local so
// OPENROUTER_API_KEY is available — it's the ONLY key needed: both the real
// chat model under test and the LLM judge run through OpenRouter. vitest does
// NOT load .env.local on its own, and Next's automatic .env loading doesn't
// apply under vitest.
//
// Only wired into the `test:evals:live` config, so the default stubbed suite
// (which needs no key) never loads env and stays hermetic. Failing to load is
// non-fatal: the live suite skips cleanly when the key is absent.
import { config } from "dotenv";

try {
  config({ path: ".env.local" });
} catch {
  // No .env.local (e.g. CI provides env directly) — that's fine; the live
  // suite's shouldRunLiveEvals() gate skips if the keys still aren't present.
}
