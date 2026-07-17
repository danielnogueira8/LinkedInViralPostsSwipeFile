import { beforeEach, describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// POST /api/voice/interview — synthesizes answers into the voice profile.
// Two paths: merge onto an existing profile, and (standalone) create a minimal
// ready row when none exists. Cost-cap gated.
// ---------------------------------------------------------------------------

const synthesizeInterviewContext = vi.fn();
const checkChatCostAllowance = vi.fn();

vi.mock("@/lib/voice-interview", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/voice-interview")>();
  return { ...orig, synthesizeInterviewContext };
});
vi.mock("@/lib/agent/rate-limit", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/agent/rate-limit")>();
  return { ...orig, checkChatCostAllowance };
});

// In-memory stand-in for the atomic claim_ai_operation RPC: the check-and-set
// is synchronous inside the mock, mirroring the DB's atomicity. The route
// releases in its finally, so sequential tests each get a fresh claim.
const claimHeld = { current: false };
vi.mock("@/lib/ai-operation-claims", () => ({
  claimAiOperation: async () => {
    if (claimHeld.current) return null;
    claimHeld.current = true;
    return "claim-1";
  },
  releaseAiOperation: async () => {
    claimHeld.current = false;
  },
}));
vi.mock("@/lib/workspace-cost-claims", () => ({
  claimWorkspaceCost: async () => "cost-claim-1",
  releaseWorkspaceCost: async () => undefined,
}));

const state: {
  existing: Record<string, unknown> | null;
  updatePayload: Record<string, unknown> | null;
  insertPayload: Record<string, unknown> | null;
} = { existing: null, updatePayload: null, insertPayload: null };

const fakeRaw = {
  from: (table: string) => {
    if (table !== "voice_profiles") throw new Error(`unexpected ${table}`);
    const chain: Record<string, unknown> = {};
    let op: "select" | "update" | "insert" = "select";
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({ data: state.existing, error: null }),
      update: (p: Record<string, unknown>) => {
        op = "update";
        state.updatePayload = p;
        return chain;
      },
      insert: (p: Record<string, unknown>) => {
        op = "insert";
        state.insertPayload = p;
        return chain;
      },
      single: async () => ({
        data: { id: "row1", status: "ready", ...(op === "insert" ? state.insertPayload : state.updatePayload) },
        error: null,
      }),
    });
    return chain;
  },
};
vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({ workspaceId: "ws1", raw: fakeRaw }),
}));

const { POST } = await import("@/app/api/voice/interview/route");

function req(body: unknown): Request {
  return new Request("http://t/api/voice/interview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ANSWERS = [{ question: "A proud result?", answer: "Cut churn 40%." }];

beforeEach(() => {
  state.existing = null;
  state.updatePayload = null;
  state.insertPayload = null;
  synthesizeInterviewContext.mockReset();
  synthesizeInterviewContext.mockResolvedValue({
    answers: ANSWERS,
    context: ["I cut a client's churn 40%."],
  });
  checkChatCostAllowance.mockReset();
  checkChatCostAllowance.mockResolvedValue({ ok: true });
  claimHeld.current = false;
});

describe("POST /api/voice/interview", () => {
  test("over cost cap → 429, no synthesis", async () => {
    checkChatCostAllowance.mockResolvedValue({ ok: false, message: "Monthly budget reached." });
    const res = await POST(req({ answers: ANSWERS }));
    expect(res.status).toBe(429);
    expect(synthesizeInterviewContext).not.toHaveBeenCalled();
  });

  test("existing ready profile → UPDATE merges interview fields onto profile", async () => {
    state.existing = { id: "row1", status: "ready", profile: { summary: "My voice" }, summary: "My voice" };
    const res = await POST(req({ answers: ANSWERS }));
    expect(res.status).toBe(200);
    const profile = state.updatePayload?.profile as Record<string, unknown>;
    expect(profile.summary).toBe("My voice"); // preserved
    expect(profile.interview_context).toEqual(["I cut a client's churn 40%."]);
    expect(profile.interview_answers).toEqual(ANSWERS);
    expect(state.insertPayload).toBeNull();
  });

  test("no profile → INSERT a minimal ready row carrying the interview (standalone)", async () => {
    state.existing = null;
    const res = await POST(req({ answers: ANSWERS }));
    expect(res.status).toBe(200);
    expect(state.updatePayload).toBeNull();
    const row = state.insertPayload!;
    expect(row.workspace_id).toBe("ws1");
    expect(row.status).toBe("ready");
    expect(row.model).toBe("interview");
    const profile = row.profile as Record<string, unknown>;
    expect(profile.interview_context).toEqual(["I cut a client's churn 40%."]);
    // A standalone row still gets a non-empty summary.
    expect(typeof row.summary).toBe("string");
    expect((row.summary as string).length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // REGRESSION (audit finding, fixed): the standalone INSERT used to stamp
  // `generated_at`, the SAME column voiceRegenCooldown() reads to gate the
  // 7-day voice-refresh cooldown. An interview-first user (who never ran a
  // real synthesis via POST /api/voice) would immediately hit "you can
  // refresh your voice again in 7 days" the first time they tried to
  // actually generate their voice from a scrape. generated_at means "a
  // synthesis run completed"; saving interview answers is not that.
  // interview_updated_at is the separate, correct timestamp for this event.
  // ---------------------------------------------------------------------------
  test("REGRESSION: standalone interview save never stamps generated_at (would falsely start the 7-day cooldown)", async () => {
    state.existing = null;
    const res = await POST(req({ answers: ANSWERS }));
    expect(res.status).toBe(200);
    const row = state.insertPayload!;
    expect(row.generated_at).toBeUndefined();
    expect(typeof row.interview_updated_at).toBe("string");
  });

  test("REGRESSION: interview save on an EXISTING profile also never touches generated_at", async () => {
    state.existing = {
      id: "row1",
      status: "ready",
      profile: { summary: "My voice" },
      summary: "My voice",
    };
    const res = await POST(req({ answers: ANSWERS }));
    expect(res.status).toBe(200);
    const update = state.updatePayload!;
    expect(update.generated_at).toBeUndefined();
    expect(typeof update.interview_updated_at).toBe("string");
  });

  test("synthesis is given the existing profile as the voice anchor", async () => {
    state.existing = { id: "row1", status: "ready", profile: { summary: "Blunt founder" }, summary: "Blunt founder" };
    await POST(req({ answers: ANSWERS }));
    expect(synthesizeInterviewContext.mock.calls[0][0].voice).toMatchObject({ summary: "Blunt founder" });
  });

  // ---------------------------------------------------------------------------
  // REGRESSION (audit finding, fixed): unlike POST /api/voice (which wraps its
  // cost check in claimAiOperation('voice-generation')), this route used to run
  // only the read-only checkChatCostAllowance before kicking off paid synthesis
  // — a pure read-then-spend race where a double-submit ran synthesis TWICE.
  // Now the route takes a claimAiOperation('voice-interview') first: exactly
  // one concurrent submit wins (200), the other is refused (409, mirroring
  // /api/voice), and synthesis runs once.
  // ---------------------------------------------------------------------------
  test("REGRESSION: concurrent double-submit triggers paid synthesis exactly once", async () => {
    state.existing = { id: "row1", status: "ready", profile: { summary: "My voice" }, summary: "My voice" };
    checkChatCostAllowance.mockResolvedValue({ ok: true });
    // Hold the winner's synthesis on a MACROTASK so it cannot finish (and
    // release the claim in its finally) before the loser — whose path to the
    // claim is all microtasks — reaches the gate. Makes the race deterministic.
    synthesizeInterviewContext.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ answers: ANSWERS, context: ["I cut a client's churn 40%."] }),
            10,
          ),
        ),
    );

    const [res1, res2] = await Promise.all([
      POST(req({ answers: ANSWERS })),
      POST(req({ answers: ANSWERS })),
    ]);

    // Exactly one winner (200) and one refusal (409) — order not guaranteed.
    expect([res1.status, res2.status].sort()).toEqual([200, 409]);
    expect(synthesizeInterviewContext).toHaveBeenCalledTimes(1);
  });
});
