import { runDailyPipeline } from "./pipeline";

declare global {
  // module-scope singletons survive HMR + per-request handler invocations in dev
  var __activeRunPromise: Promise<unknown> | undefined;
  var __activeRunId: string | undefined;
}

export async function startBackgroundRun(): Promise<{ runId: string; alreadyRunning: boolean }> {
  if (globalThis.__activeRunPromise && globalThis.__activeRunId) {
    return { runId: globalThis.__activeRunId, alreadyRunning: true };
  }
  let resolveId: (id: string) => void = () => {};
  const idPromise = new Promise<string>((r) => { resolveId = r; });

  const promise = (async () => {
    try {
      // pipeline creates the run row and starts working
      const result = await runDailyPipeline();
      // resolve in case the run finished before we registered the id (unlikely but safe)
      resolveId(result.runId);
      return result;
    } finally {
      globalThis.__activeRunPromise = undefined;
      globalThis.__activeRunId = undefined;
    }
  })();
  globalThis.__activeRunPromise = promise;

  // We don't have the runId synchronously. Race: pipeline inserts the row almost
  // immediately, so poll the DB for the latest "running" row started after now.
  const started = Date.now();
  const sb = (await import("./supabase")).supabaseAdmin();
  for (let i = 0; i < 40; i++) {
    const { data } = await sb
      .from("runs")
      .select("id, started_at")
      .eq("status", "running")
      .gte("started_at", new Date(started - 1000).toISOString())
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data?.id) {
      globalThis.__activeRunId = data.id;
      resolveId(data.id);
      return { runId: data.id, alreadyRunning: false };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  // Fallback: wait for the pipeline itself to report its id
  const runId = await idPromise;
  globalThis.__activeRunId = runId;
  return { runId, alreadyRunning: false };
}

export function activeRunId(): string | undefined {
  return globalThis.__activeRunId;
}
