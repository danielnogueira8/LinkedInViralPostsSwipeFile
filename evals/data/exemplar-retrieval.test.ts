import { describe, test, expect, vi, beforeEach } from "vitest";
import { AdapterHealthRegistry } from "@/lib/agent/adapter-health";
import { createCoworkTurnTelemetry } from "@/lib/agent/cowork-telemetry";

// Retrieval-augmented drafting (viral-learning loop, PR 3). We mock the two
// dependencies — the embedding RPC (retrieveExemplars) and the body fetch
// (supabaseAdmin) — and test buildExemplarBlock's assembly: the WORKED /
// UNDERPERFORMED sections, the diversity down-sample, and the empty short-
// circuits. The retrieval math itself lives in pgvector; this is the block.

const { retrieveExemplars, embedText } = vi.hoisted(() => ({
  retrieveExemplars: vi.fn(),
  embedText: vi.fn(),
}));
vi.mock("@/lib/post-embeddings", () => ({ embedText, retrieveExemplars }));

// A fake posts.select("id, text").in("id", ids) → { data: rows }.
let bodyRows: Array<{ id: string; text: string | null }> = [];
let bodyAbortSignals: AbortSignal[] = [];
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.in = () => chain;
      chain.abortSignal = (signal: AbortSignal) => {
        bodyAbortSignals.push(signal);
        return chain;
      };
      chain.then = (resolve: (v: { data: unknown; error: null }) => unknown) =>
        resolve({ data: bodyRows, error: null });
      return chain;
    },
  }),
}));

const { buildExemplarBlock } = await import("@/lib/batch/exemplar-retrieval");

beforeEach(() => {
  retrieveExemplars.mockReset();
  embedText.mockReset();
  embedText.mockResolvedValue({
    embeddings: [Array.from({ length: 1536 }, () => 0.01)],
    model: "openai/text-embedding-3-small",
    promptTokens: 7,
  });
  bodyRows = [];
  bodyAbortSignals = [];
});

// retrieveExemplars is called twice (wantViral true then false). Configure both
// return values in call order.
function stubMatches(viralIds: string[], mediocreIds: string[]) {
  retrieveExemplars
    .mockResolvedValueOnce(viralIds.map((postId) => ({ postId, similarity: 0.9 })))
    .mockResolvedValueOnce(mediocreIds.map((postId) => ({ postId, similarity: 0.5 })));
}

describe("buildExemplarBlock", () => {
  test("empty topic short-circuits with no retrieval", async () => {
    const out = await buildExemplarBlock({ topicText: "   " });
    expect(out.block).toBe("");
    expect(retrieveExemplars).not.toHaveBeenCalled();
    expect(embedText).not.toHaveBeenCalled();
  });

  test("assembles WORKED + UNDERPERFORMED sections from retrieved bodies", async () => {
    stubMatches(["v1", "v2"], ["m1"]);
    bodyRows = [
      { id: "v1", text: "Alpha hook that crushed it on this topic." },
      { id: "v2", text: "Bravo different opener that also worked well." },
      { id: "m1", text: "Charlie flat post nobody engaged with." },
    ];

    const out = await buildExemplarBlock({ topicText: "founder-led sales" });

    expect(out.viralCount).toBe(2);
    expect(out.mediocreCount).toBe(1);
    expect(out.block).toContain("WORKED");
    expect(out.block).toContain("UNDERPERFORMED");
    expect(out.block).toContain("Alpha hook");
    expect(out.block).toContain("Charlie flat post");
    // The anti-copying instruction must be present.
    expect(out.block).toMatch(/never copy their wording/i);
  });

  test("down-samples near-duplicate openers for structural diversity", async () => {
    // Two viral matches share the same opening fingerprint; only one survives.
    stubMatches(["v1", "v2", "v3"], []);
    bodyRows = [
      { id: "v1", text: "Stop chasing leads and start building systems now." },
      { id: "v2", text: "Stop chasing leads and start building systems today." },
      { id: "v3", text: "A completely different angle on retention economics." },
    ];

    const out = await buildExemplarBlock({ topicText: "leads" });
    // v1 and v2 collapse to one; v3 is distinct → 2 shown, not 3.
    expect(out.viralCount).toBe(2);
    expect(out.block).toContain("different angle on retention");
  });

  test("no retrieved matches → empty block (caller appends nothing)", async () => {
    stubMatches([], []);
    const out = await buildExemplarBlock({ topicText: "anything" });
    expect(out.block).toBe("");
    expect(out.viralCount).toBe(0);
    expect(out.mediocreCount).toBe(0);
  });

  test("matches whose bodies are missing are dropped, not rendered blank", async () => {
    stubMatches(["v1", "gone"], []);
    // Only v1 has a body row; "gone" was deleted between retrieval and fetch.
    bodyRows = [{ id: "v1", text: "The one surviving viral exemplar." }];
    const out = await buildExemplarBlock({ topicText: "topic" });
    expect(out.viralCount).toBe(1);
    expect(out.block).toContain("one surviving viral exemplar");
  });

  test("passes the source id as an exclusion and the post type through", async () => {
    stubMatches([], []);
    await buildExemplarBlock({
      topicText: "topic",
      postType: "lead_magnet",
      excludeIds: ["source-1"],
    });
    const firstCall = retrieveExemplars.mock.calls[0][0];
    expect(firstCall.excludeIds).toEqual(["source-1"]);
    expect(firstCall.postType).toBe("lead_magnet");
    expect(firstCall.wantViral).toBe(true);
    const secondCall = retrieveExemplars.mock.calls[1][0];
    expect(secondCall.wantViral).toBe(false);
    expect(embedText).toHaveBeenCalledOnce();
    expect(firstCall.queryEmbedding).toBe(secondCall.queryEmbedding);
  });

  test("records the single shared query embedding attempt", async () => {
    const sink = vi.fn();
    const telemetry = createCoworkTurnTelemetry(
      {
        traceId: "exemplar-embedding",
        workspaceId: "ws-1",
        route: "legacy_agent",
        requestedContract: { kind: "post", expectedCount: 1 },
      },
      sink,
    );
    stubMatches([], []);

    await buildExemplarBlock({
      topicText: "founder-led sales",
      telemetry,
      adapterHealth: new AdapterHealthRegistry(),
    });
    telemetry.finish({
      deliveredContract: { kind: "post", deliveredCount: 0 },
      provenanceStatus: "not_required",
      terminalOutcome: "clarified",
    });

    expect(embedText).toHaveBeenCalledOnce();
    expect(sink.mock.calls[0][0].stage_attempts).toContainEqual(
      expect.objectContaining({
        stage: "legacy_exemplar_embedding",
        provider: "openrouter",
        outcome: "accepted",
        input_tokens: 7,
      }),
    );
  });

  test("threads cancellation through both match RPCs and the body query", async () => {
    const controller = new AbortController();
    stubMatches(["v1"], []);
    bodyRows = [{ id: "v1", text: "A cancellable exemplar." }];

    await buildExemplarBlock({
      topicText: "founder-led sales",
      signal: controller.signal,
    });

    expect(retrieveExemplars).toHaveBeenCalledTimes(2);
    expect(retrieveExemplars.mock.calls[0][0].signal).toBe(controller.signal);
    expect(retrieveExemplars.mock.calls[1][0].signal).toBe(controller.signal);
    expect(bodyAbortSignals).toEqual([controller.signal]);
  });
});
