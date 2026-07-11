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

  test("synthesis is given the existing profile as the voice anchor", async () => {
    state.existing = { id: "row1", status: "ready", profile: { summary: "Blunt founder" }, summary: "Blunt founder" };
    await POST(req({ answers: ANSWERS }));
    expect(synthesizeInterviewContext.mock.calls[0][0].voice).toMatchObject({ summary: "Blunt founder" });
  });
});
