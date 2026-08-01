import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { runGlobalErrorRetry } from "@/app/global-error";

const source = readFileSync("app/global-error.tsx", "utf8");

describe("global error retry contract", () => {
  test("runs Next's retry callback before the hard reload", () => {
    const retry = vi.fn();
    const reload = vi.fn();

    runGlobalErrorRetry(retry, reload);

    expect(retry).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
    expect(retry.mock.invocationCallOrder[0]).toBeLessThan(
      reload.mock.invocationCallOrder[0],
    );
  });

  test("uses the Next 16 unstable_retry error-boundary prop", () => {
    expect(source).toContain("unstable_retry");
    expect(source).not.toContain("reset: () => void");
  });
});
