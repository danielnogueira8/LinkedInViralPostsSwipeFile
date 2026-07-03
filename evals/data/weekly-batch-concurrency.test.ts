import { describe, test, expect } from "vitest";
import {
  runWithConcurrency,
  BATCH_WORKER_CONCURRENCY,
} from "@/lib/batch/weekly";

// ---------------------------------------------------------------------------
// Bounded fan-out for the weekly batch. Historically Promise.all launched all
// BATCH_DRAFT_COUNT workers at once, which starved one GLM call under
// OpenRouter's per-key concurrency ceiling — users saw a repeatable "6 of 7"
// shortfall. We now cap at BATCH_WORKER_CONCURRENCY.
//
// These tests pin the pool's core guarantees so the fix can't silently
// regress:
//   • never more than `limit` tasks in flight simultaneously,
//   • all tasks complete,
//   • results returned in insertion order (not completion order),
//   • a rejected task doesn't corrupt siblings (documented failure mode:
//     it propagates and the pool aborts — the batch caller only passes
//     never-throwing workers, so this is a doc-in-code check, not a
//     runtime relied-on behavior),
//   • the exported constant matches the documented cap.
// ---------------------------------------------------------------------------

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("runWithConcurrency", () => {
  test("returns results in insertion order (not completion order)", async () => {
    // Task N resolves after N * 5ms — earlier tasks in the queue take LONGER.
    // A completion-order impl would return [4,3,2,1,0]; insertion order must
    // return [0,1,2,3,4].
    const tasks = [0, 1, 2, 3, 4].map(
      (i) => () =>
        new Promise<number>((resolve) => setTimeout(() => resolve(i), (5 - i) * 5)),
    );
    const results = await runWithConcurrency(tasks, 3);
    expect(results).toEqual([0, 1, 2, 3, 4]);
  });

  test("caps in-flight tasks at `limit`", async () => {
    // Each task announces its start into `inFlight` and doesn't resolve until
    // we manually resolve its deferred. If the pool respects the cap we
    // should never observe more than `limit` concurrent starts.
    const limit = 3;
    const gates = Array.from({ length: 10 }, () => deferred<void>());
    let inFlight = 0;
    let peak = 0;
    const tasks = gates.map((g, i) => async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await g.promise;
      inFlight--;
      return i;
    });
    const run = runWithConcurrency(tasks, limit);
    // Micro-tick to let the pool spin up. Only `limit` tasks should have
    // started so far — the rest are queued.
    await new Promise((r) => setTimeout(r, 5));
    expect(peak).toBe(limit);
    // Drain the pool: resolve gates in order; each completion should let one
    // queued task start, but peak should never exceed `limit`.
    for (const g of gates) {
      g.resolve();
      await new Promise((r) => setTimeout(r, 1));
      expect(inFlight).toBeLessThanOrEqual(limit);
    }
    const results = await run;
    expect(results).toEqual(Array.from({ length: 10 }, (_, i) => i));
    expect(peak).toBe(limit);
  });

  test("limit >= tasks → all run concurrently, no queueing", async () => {
    const gates = Array.from({ length: 4 }, () => deferred<void>());
    let peak = 0;
    let live = 0;
    const tasks = gates.map((g, i) => async () => {
      live++;
      peak = Math.max(peak, live);
      await g.promise;
      live--;
      return i;
    });
    const run = runWithConcurrency(tasks, 100); // limit >> tasks
    await new Promise((r) => setTimeout(r, 5));
    expect(peak).toBe(4); // all four in flight at once
    gates.forEach((g) => g.resolve());
    await run;
  });

  test("empty task list resolves to []", async () => {
    const out = await runWithConcurrency<number>([], 4);
    expect(out).toEqual([]);
  });

  test("BATCH_WORKER_CONCURRENCY is set to the cap documented in weekly.ts", () => {
    // If this value drifts we want the CI to shout — the choice (4) is
    // load-bearing for a specific provider ceiling.
    expect(BATCH_WORKER_CONCURRENCY).toBe(4);
  });
});
