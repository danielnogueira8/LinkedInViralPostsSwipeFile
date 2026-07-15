import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  abortSignals: [] as AbortSignal[],
}));

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({
    rpc: () => {
      const query: Record<string, unknown> = {};
      query.abortSignal = (signal: AbortSignal) => {
        state.abortSignals.push(signal);
        return query;
      };
      query.then = (
        resolve: (result: {
          data: Array<{ post_id: string; similarity: number }>;
          error: null;
        }) => unknown,
      ) => resolve({ data: [{ post_id: "post-1", similarity: 0.9 }], error: null });
      return query;
    },
  }),
}));

const { retrieveExemplars } = await import("@/lib/post-embeddings");

describe("exemplar retrieval cancellation", () => {
  beforeEach(() => {
    state.abortSignals = [];
  });

  test("binds the turn signal to the match RPC when reusing an embedding", async () => {
    const controller = new AbortController();

    await expect(
      retrieveExemplars({
        queryText: "distribution",
        queryEmbedding: [0.1, 0.2],
        wantViral: true,
        signal: controller.signal,
      }),
    ).resolves.toEqual([{ postId: "post-1", similarity: 0.9 }]);

    expect(state.abortSignals).toEqual([controller.signal]);
  });

  test("does not dispatch the RPC when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      retrieveExemplars({
        queryText: "distribution",
        queryEmbedding: [0.1, 0.2],
        wantViral: true,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(state.abortSignals).toHaveLength(0);
  });
});
