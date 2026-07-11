// Next.js instrumentation hook — runs ONCE when the server process boots,
// before any request is served. We use it to fail-fast on a missing required
// env var (Supabase / OpenRouter / CRON_SECRET) so a misconfigured deploy
// throws a clear, aggregated error at startup instead of an opaque 500 on the
// first request that happens to need the var.
//
// Guarded to the Node.js runtime: the Edge runtime doesn't run the server-only
// data/LLM paths these vars gate, and process.env is populated differently
// there. NODE_ENV check skips validation under test (vitest sets its own env).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NODE_ENV === "test") return;
  const { validateEnv } = await import("@/lib/env");
  validateEnv();
}
