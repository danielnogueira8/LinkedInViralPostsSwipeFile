import { describe, expect, test, vi } from "vitest";
import {
  aiTellRepairStage,
  contractStage,
  editStage,
  finalTransformStage,
  provenanceStage,
  resolveSource,
  sanityStage,
  sourceFidelityStage,
  type StageContext,
  type StageState,
} from "@/lib/agent/finalize/finalizer-stages";
import type { DraftCandidate, DraftFinalizerSpecialists } from "@/lib/agent/finalize/finalizer";

const COMPLETE_POST = [
  "Most LinkedIn posts do not fail because the writing is bad.",
  "",
  "They fail because the writer starts before deciding what they actually believe.",
].join("\n");

function passThroughSpecialists(): DraftFinalizerSpecialists {
  return {
    edit: vi.fn((body) => ({
      body,
      changed: false,
      usedModel: false,
      fixedCategories: [],
      notes: [],
    })),
    repairAiTells: vi.fn(async ({ body }) => ({
      body,
      repaired: false,
      detected: [],
    })),
    checkSameness: vi.fn(async ({ body }) => ({
      body,
      rewrote: false,
      overlapMarkers: [],
      reason: "",
    })),
    reviewSourceFidelity: vi.fn(async () => ({
      outcome: "verified" as const,
    })),
  };
}

function candidate(overrides: Partial<DraftCandidate> = {}): DraftCandidate {
  return { origin: "render_tool", body: COMPLETE_POST, ...overrides };
}

function ctx(overrides: Partial<StageContext> = {}): StageContext {
  return {
    workspaceId: "ws-1",
    candidate: candidate(),
    acceptedCount: 0,
    isDuplicateOfRejected: () => false,
    maxPostChars: 3500,
    specialists: passThroughSpecialists(),
    aborted: () => false,
    ...overrides,
  };
}

function state(overrides: Partial<StageState> = {}): StageState {
  return {
    origin: "render_tool",
    body: COMPLETE_POST,
    sourceVerified: false,
    edited: false,
    repaired: false,
    ...overrides,
  };
}

describe("sanityStage", () => {
  test("rejects an unclosed envelope as truncated", () => {
    const result = sanityStage(ctx(), state({ envelopeComplete: false }));
    expect(result).toMatchObject({ ok: false, rejection: { code: "truncated" } });
  });

  test("rejects an empty body", () => {
    const result = sanityStage(ctx(), state({ body: "   " }));
    expect(result).toMatchObject({ ok: false, rejection: { code: "empty" } });
  });

  test("rejects finishReason length as truncated", () => {
    const result = sanityStage(ctx(), state({ finishReason: "length" }));
    expect(result).toMatchObject({ ok: false, rejection: { code: "truncated" } });
  });

  test("rejects corrupted markup", () => {
    const body = 'A clean start\n\n```json\n{"body":"leak"}\n```';
    const result = sanityStage(ctx(), state({ body }));
    expect(result).toMatchObject({ ok: false, rejection: { code: "corrupted" } });
  });

  test("rejects a candidate already marked duplicate-of-rejected", () => {
    const result = sanityStage(
      ctx({ isDuplicateOfRejected: () => true }),
      state(),
    );
    expect(result).toMatchObject({ ok: false, rejection: { code: "duplicate" } });
  });

  test("applies transformCandidate and carries the transformed body forward", () => {
    const result = sanityStage(
      ctx({ transformCandidate: (body) => ({ ok: true, body: `${body}\n\nAppended.` }) }),
      state(),
    );
    expect(result).toMatchObject({ ok: true, state: { body: `${COMPLETE_POST}\n\nAppended.` } });
  });

  test("rejects when transformCandidate fails", () => {
    const result = sanityStage(
      ctx({ transformCandidate: () => ({ ok: false, message: "does not match the lead magnet" }) }),
      state(),
    );
    expect(result).toMatchObject({ ok: false, rejection: { code: "domain_constraint" } });
  });

  test("passes a clean candidate through unchanged", () => {
    const result = sanityStage(ctx(), state());
    expect(result).toMatchObject({ ok: true, state: { body: COMPLETE_POST } });
  });
});

describe("contractStage", () => {
  test("passes through when no contract is set", () => {
    const result = contractStage(ctx(), state());
    expect(result).toMatchObject({ ok: true });
  });

  test("rejects once the exact-count contract is already satisfied", () => {
    const result = contractStage(
      ctx({ contract: { kind: "post", expectedCount: 1 }, acceptedCount: 1 }),
      state(),
    );
    expect(result).toMatchObject({ ok: false, rejection: { code: "count_complete" } });
  });

  test("passes when the contract still has room", () => {
    const result = contractStage(
      ctx({ contract: { kind: "post", expectedCount: 2 }, acceptedCount: 1 }),
      state(),
    );
    expect(result).toMatchObject({ ok: true });
  });
});

describe("resolveSource / provenanceStage", () => {
  const SOURCE_ID = "11111111-1111-4111-8111-111111111111";

  test("no provenance on the candidate resolves to no source, not verified", () => {
    const result = provenanceStage(ctx({ candidate: candidate() }), state());
    expect(result).toMatchObject({ ok: true, source: null, state: { sourceVerified: false } });
  });

  test("required provenance with no resolvable id rejects provenance_missing", () => {
    const c = candidate({
      provenance: {
        required: true,
        requestedSourceId: null,
        discoveredSources: [
          { id: SOURCE_ID, text: "a" },
          { id: "22222222-2222-4222-8222-222222222222", text: "b" },
        ],
        userRequest: "Model a source post",
        verifiedContext: "USER: Model a source post",
      },
    });
    const result = provenanceStage(ctx({ candidate: c }), state());
    expect(result).toMatchObject({ ok: false, rejection: { code: "provenance_missing" } });
  });

  test("a requested id absent from discovered sources rejects provenance_unverified", () => {
    const c = candidate({
      provenance: {
        required: true,
        requestedSourceId: "33333333-3333-4333-8333-333333333333",
        discoveredSources: [{ id: SOURCE_ID, text: "a" }],
        userRequest: "Model a source post",
        verifiedContext: "USER: Model a source post",
      },
    });
    const result = provenanceStage(ctx({ candidate: c }), state());
    expect(result).toMatchObject({ ok: false, rejection: { code: "provenance_unverified" } });
  });

  test("an empty-text matched source rejects source_unavailable", () => {
    const c = candidate({
      provenance: {
        required: true,
        requestedSourceId: SOURCE_ID,
        discoveredSources: [{ id: SOURCE_ID, text: "" }],
        userRequest: "Model a source post",
        verifiedContext: "USER: Model a source post",
      },
    });
    const result = provenanceStage(ctx({ candidate: c }), state());
    expect(result).toMatchObject({ ok: false, rejection: { code: "source_unavailable" } });
  });

  test("a resolved source marks sourceVerified and returns the source row", () => {
    const c = candidate({
      provenance: {
        required: true,
        requestedSourceId: SOURCE_ID,
        discoveredSources: [{ id: SOURCE_ID, text: "Source post" }],
        userRequest: "Model a source post",
        verifiedContext: "USER: Model a source post",
      },
    });
    const result = provenanceStage(ctx({ candidate: c }), state());
    expect(result).toMatchObject({
      ok: true,
      source: { id: SOURCE_ID, text: "Source post" },
      state: { sourceVerified: true },
    });
  });

  test("only render_tool auto-requires a match when required is false but sources exist", () => {
    const provenance = {
      required: false,
      requestedSourceId: null,
      discoveredSources: [
        { id: SOURCE_ID, text: "a" },
        { id: "22222222-2222-4222-8222-222222222222", text: "b" },
      ],
      userRequest: "Brandjack apple",
      verifiedContext: "USER: Brandjack apple",
    };
    expect(resolveSource(provenance, "render_tool")).toMatchObject({
      ok: false,
      code: "provenance_missing",
    });
    expect(resolveSource(provenance, "legacy_fence")).toMatchObject({ ok: true, source: null });
  });
});

describe("editStage", () => {
  test("carries the editor's output body and changed flag into state", () => {
    const specialists = passThroughSpecialists();
    specialists.edit = vi.fn(() => ({
      body: "Edited body.",
      changed: true,
      usedModel: false,
      fixedCategories: ["em_dash" as const],
      notes: [],
    }));
    const result = editStage(ctx({ specialists }), state());
    expect(result).toMatchObject({ ok: true, state: { body: "Edited body.", edited: true } });
    expect(specialists.edit).toHaveBeenCalledWith(COMPLETE_POST, "post", undefined);
  });

  test("reads editOptions by reference at call time", () => {
    const specialists = passThroughSpecialists();
    const editOptions = { keepEmDashes: false };
    editStage(ctx({ specialists, editOptions }), state());
    expect(specialists.edit).toHaveBeenCalledWith(COMPLETE_POST, "post", editOptions);
  });
});

describe("sourceFidelityStage", () => {
  const SOURCE_ID = "11111111-1111-4111-8111-111111111111";

  test("skips the reviewer entirely when the candidate carries no provenance", async () => {
    const specialists = passThroughSpecialists();
    const result = await sourceFidelityStage(
      ctx({ specialists, candidate: candidate({ provenance: undefined }) }),
      state(),
      { id: SOURCE_ID, text: "Source" },
    );
    expect(result).toMatchObject({ ok: true });
    expect(specialists.reviewSourceFidelity).not.toHaveBeenCalled();
  });

  test("is telemetry-only: a rejected verdict still passes the stage", async () => {
    const specialists = passThroughSpecialists();
    specialists.reviewSourceFidelity = vi.fn(async () => ({
      outcome: "rejected" as const,
      reasons: ["unrelated structure"],
      retryInstruction: "Mirror the source's shape.",
    }));
    const telemetry = { recordAttempt: vi.fn() };
    const c = candidate({
      provenance: {
        required: true,
        requestedSourceId: SOURCE_ID,
        discoveredSources: [{ id: SOURCE_ID, text: "Source post" }],
        userRequest: "Model the source.",
        verifiedContext: "USER: Model the source.",
      },
    });
    const result = await sourceFidelityStage(
      ctx({ specialists, candidate: c, telemetry: telemetry as never }),
      state(),
      { id: SOURCE_ID, text: "Source post" },
    );
    expect(result).toMatchObject({ ok: true });
    expect(telemetry.recordAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "finalizer_source_fidelity_verdict",
        outcome: "rejected",
      }),
    );
  });

  test("rejects with cancelled if the signal aborts mid-review", async () => {
    const specialists = passThroughSpecialists();
    const c = candidate({
      provenance: {
        required: true,
        requestedSourceId: SOURCE_ID,
        discoveredSources: [{ id: SOURCE_ID, text: "Source post" }],
        userRequest: "Model the source.",
        verifiedContext: "USER: Model the source.",
      },
    });
    const result = await sourceFidelityStage(
      ctx({ specialists, candidate: c, aborted: () => true }),
      state(),
      { id: SOURCE_ID, text: "Source post" },
    );
    expect(result).toMatchObject({ ok: false, rejection: { code: "cancelled" } });
  });
});

describe("aiTellRepairStage", () => {
  test("carries the repair specialist's body and repaired flag into state", async () => {
    const specialists = passThroughSpecialists();
    specialists.repairAiTells = vi.fn(async () => ({
      body: "Repaired body.",
      repaired: true,
      detected: ["formulaic-opener"],
    }));
    const result = await aiTellRepairStage(ctx({ specialists }), state());
    expect(result).toMatchObject({ ok: true, state: { body: "Repaired body.", repaired: true } });
  });

  test("rejects a draft when the repair pass leaves a detected tell behind", async () => {
    const body = "Your offer gets copied. Your price gets undercut. Your product gets cloned.";
    const specialists = passThroughSpecialists();
    specialists.repairAiTells = vi.fn(async () => ({
      body,
      repaired: false,
      detected: ["repeated-opener"],
    }));

    const result = await aiTellRepairStage(
      ctx({ specialists }),
      state({ body }),
    );

    expect(result).toMatchObject({
      ok: false,
      rejection: {
        code: "domain_constraint",
        repairInstruction: expect.stringContaining("repeated-opener"),
      },
    });
  });

  test("forwards keepEmDashes from editOptions and the character-range ceiling", async () => {
    const specialists = passThroughSpecialists();
    await aiTellRepairStage(
      ctx({ specialists, editOptions: { keepEmDashes: true }, characterRangeMax: 500 }),
      state(),
    );
    expect(specialists.repairAiTells).toHaveBeenCalledWith(
      expect.objectContaining({ keepEmDashes: true, maxChars: 500 }),
    );
  });

  test("rejects with cancelled if the signal aborts mid-repair", async () => {
    const specialists = passThroughSpecialists();
    const result = await aiTellRepairStage(
      ctx({ specialists, aborted: () => true }),
      state(),
    );
    expect(result).toMatchObject({ ok: false, rejection: { code: "cancelled" } });
  });
});

describe("finalTransformStage", () => {
  test("passes through unchanged with no finalTransformCandidate configured", () => {
    const result = finalTransformStage(ctx(), state());
    expect(result).toMatchObject({ ok: true, state: { body: COMPLETE_POST } });
  });

  test("rejects when the trusted transform fails", () => {
    const result = finalTransformStage(
      ctx({ finalTransformCandidate: () => ({ ok: false, message: "bad splice" }) }),
      state(),
    );
    expect(result).toMatchObject({ ok: false, rejection: { code: "domain_constraint" } });
  });

  test("rejects when the transform produces an empty body", () => {
    const result = finalTransformStage(
      ctx({ finalTransformCandidate: () => ({ ok: true, body: "   " }) }),
      state(),
    );
    expect(result).toMatchObject({ ok: false, rejection: { code: "empty" } });
  });

  test("rejects when the transform introduces corrupted markup", () => {
    const result = finalTransformStage(
      ctx({
        finalTransformCandidate: () => ({
          ok: true,
          body: 'A start\n\n```json\n{"body":"leak"}\n```',
        }),
      }),
      state(),
    );
    expect(result).toMatchObject({ ok: false, rejection: { code: "corrupted" } });
  });

  test("rejects when the resulting body exceeds the hard character cap", () => {
    const result = finalTransformStage(
      ctx({ maxPostChars: 10 }),
      state({ body: "This body is far longer than ten characters." }),
    );
    expect(result).toMatchObject({ ok: false, rejection: { code: "character_range" } });
  });
});
