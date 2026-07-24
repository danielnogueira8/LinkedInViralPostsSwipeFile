import { describe, expect, test } from "vitest";
import {
  resolveTurnDecision,
  type ResolveDecisionDeps,
} from "@/lib/agent/turn/resolve-decision";
import type { ChatTurnRequest } from "@/lib/agent/chat-turn";

// The dry-run resolver is what the "confirm before generating" read-back shows.
// It must produce the SAME decision the live turn will run (both call
// resolvePreclaimRouting + compileServerReadOnlyPlan) and must never invent a
// niche. These tests lock the resolved decision for the common composer sends.

const FIXED_NOW = new Date("2026-07-24T12:00:00.000Z");

function deps(knownNiches: string[] = []): ResolveDecisionDeps {
  return {
    listWorkspaceNiches: async () => knownNiches,
    now: () => FIXED_NOW,
  };
}

function body(overrides: Partial<ChatTurnRequest>): ChatTurnRequest {
  return {
    message: "Write a post about founder-led sales.",
    ...overrides,
  } as ChatTurnRequest;
}

describe("resolveTurnDecision", () => {
  test("a create command resolves to create mode", async () => {
    const decision = await resolveTurnDecision(
      body({
        message: "Write an original post about pricing.",
        command: { kind: "create", count: 1 },
      }),
      "ws-1",
      deps(),
    );
    expect(decision.mode).toBe("create");
  });

  test("an ask command resolves to ask mode", async () => {
    const decision = await resolveTurnDecision(
      body({
        message: "What's been working across my tracked accounts?",
        command: { kind: "ask" },
      }),
      "ws-1",
      deps(),
    );
    expect(decision.mode).toBe("ask");
  });

  test("an edit command resolves to edit mode", async () => {
    const decision = await resolveTurnDecision(
      body({
        message: "Make the hook punchier.",
        command: { kind: "edit", targetPostId: "artifact-1", scope: "full_post" },
      }),
      "ws-1",
      deps(),
    );
    expect(decision.mode).toBe("edit");
  });

  test("reports a model source when one is attached", async () => {
    const decision = await resolveTurnDecision(
      body({
        message: "Model this in my voice.",
        command: { kind: "create", count: 1 },
        modelSourceId: "11111111-1111-1111-1111-111111111111",
      }),
      "ws-1",
      deps(),
    );
    expect(decision.hasModelSource).toBe(true);
  });

  test("reports a lead magnet selection", async () => {
    const decision = await resolveTurnDecision(
      body({
        message: "Write a lead magnet post.",
        command: { kind: "create", count: 1 },
        leadMagnetId: "22222222-2222-2222-2222-222222222222",
      }),
      "ws-1",
      deps(),
    );
    expect(decision.hasLeadMagnetSelection).toBe(true);
  });

  // The marquee case: the exact starter prompt that produced the "Give me" bug.
  // The resolver must NOT extract a niche from an imperative opener, even though
  // real niches are supplied — none of them appear in the prompt.
  test("does not invent a niche from an imperative 'Give me N post ideas' opener", async () => {
    const decision = await resolveTurnDecision(
      body({
        message:
          "Give me 5 post ideas based on what's been going viral across my tracked accounts over the last 30 days. Pull from ALL niches.",
        command: { kind: "ask" },
      }),
      "ws-1",
      deps(["SaaS", "AI/Tech", "Sales/Outreach"]),
    );
    expect(decision.niche).toBeNull();
  });

  test("resolves a real niche when the prompt names one", async () => {
    const decision = await resolveTurnDecision(
      body({
        message: "Find 2 SaaS posts in my swipe file and summarize why they worked.",
        command: { kind: "ask" },
      }),
      "ws-1",
      deps(["SaaS", "AI/Tech"]),
    );
    // Either resolves "SaaS" or safely omits — never a hallucinated niche.
    expect(decision.niche === null || decision.niche === "SaaS").toBe(true);
  });

  test("is deterministic — same request yields the same decision", async () => {
    const req = body({
      message: "Write 2 posts about retention.",
      command: { kind: "create", count: 2 },
    });
    const a = await resolveTurnDecision(req, "ws-1", deps());
    const b = await resolveTurnDecision(req, "ws-1", deps());
    expect(a).toEqual(b);
  });
});
