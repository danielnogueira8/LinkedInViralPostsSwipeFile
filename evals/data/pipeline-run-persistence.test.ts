import { describe, expect, test, vi } from "vitest";

const runUpdates: Array<Record<string, unknown>> = [];

function fakeSupabase() {
  return {
    from(table: string) {
      let update: Record<string, unknown> | null = null;
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = chain;
      builder.is = chain;
      builder.order = chain;
      builder.eq = chain;
      builder.update = (value: Record<string, unknown>) => {
        update = value;
        if (table === "runs") runUpdates.push(value);
        return builder;
      };
      builder.then = (
        resolve: (value: { data: unknown; error: { message: string } | null }) => unknown,
      ) => {
        if (table === "accounts") return resolve({ data: [], error: null });
        if (table === "runs" && update?.phase === "done") {
          return resolve({ data: null, error: { message: "run state unavailable" } });
        }
        return resolve({ data: null, error: null });
      };
      return builder;
    },
  };
}

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => fakeSupabase() }));
vi.mock("@/lib/apify", () => ({ runOneProfile: vi.fn(), normalizePost: vi.fn() }));

const { runDailyPipeline } = await import("@/lib/pipeline");

describe("daily pipeline run persistence", () => {
  test("does not report success when the terminal run update fails", async () => {
    runUpdates.length = 0;

    await expect(
      runDailyPipeline("workspace-1", { runId: "run-1" }),
    ).rejects.toThrow("run state unavailable");

    expect(runUpdates.some((update) => update.phase === "error")).toBe(true);
  });
});
