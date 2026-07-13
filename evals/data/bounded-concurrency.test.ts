import { describe, expect, it } from "vitest";
import { runWithConcurrency } from "@/lib/bounded-concurrency";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("runWithConcurrency", () => {
  it("caps in-flight tasks and preserves result order", async () => {
    const gates = Array.from({ length: 8 }, () => deferred<void>());
    let inFlight = 0;
    let peak = 0;
    const running = runWithConcurrency(gates.map((gate, index) => async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await gate.promise;
      inFlight -= 1;
      return index;
    }), 3);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(peak).toBe(3);
    for (const gate of gates) {
      gate.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(inFlight).toBeLessThanOrEqual(3);
    }
    await expect(running).resolves.toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("rejects invalid limits instead of silently skipping work", async () => {
    await expect(runWithConcurrency([async () => 1], 0)).rejects.toThrow(RangeError);
  });
});
