import { beforeEach, describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// Voice context interview: sanitize of the new profile fields + the synthesis
// (raw answers → voice-matched context via a forced tool). The freshness/skip
// handling is the safety net — a blank answer must never persist, and the
// synthesizer must never be asked to invent for zero answers.
// ---------------------------------------------------------------------------

const completeChat = vi.fn();
const logOpenRouterUsage = vi.fn(async () => {});

vi.mock("@/lib/openrouter", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/openrouter")>();
  return { ...orig, completeChat, logOpenRouterUsage };
});

const { sanitizeVoiceProfile, sanitizeInterviewAnswers } = await import("@/lib/claude");
const { synthesizeInterviewContext, INTERVIEW_QUESTIONS } = await import(
  "@/lib/voice-interview"
);

describe("sanitizeInterviewAnswers", () => {
  test("drops blank-answer (skipped) questions and trims", () => {
    const out = sanitizeInterviewAnswers([
      { question: "  Q1  ", answer: "  A1  " },
      { question: "Q2", answer: "" },
      { question: "Q3", answer: "   " },
      { question: "", answer: "orphan" },
    ]);
    expect(out).toEqual([{ question: "Q1", answer: "A1" }]);
  });

  test("junk input → empty, never throws", () => {
    expect(sanitizeInterviewAnswers(null)).toEqual([]);
    expect(sanitizeInterviewAnswers("nope")).toEqual([]);
    expect(sanitizeInterviewAnswers([1, true, null])).toEqual([]);
  });
});

describe("sanitizeVoiceProfile — interview fields", () => {
  test("preserves interview_answers + interview_context when non-empty", () => {
    const p = sanitizeVoiceProfile({
      summary: "s",
      interview_answers: [{ question: "Q", answer: "A" }, { question: "Q2", answer: "" }],
      interview_context: ["I believe X.", "  ", "I did Y."],
    });
    expect(p.interview_answers).toEqual([{ question: "Q", answer: "A" }]);
    expect(p.interview_context).toEqual(["I believe X.", "I did Y."]);
  });

  test("drops the fields entirely when empty (distinguishable 'never done')", () => {
    const p = sanitizeVoiceProfile({
      summary: "s",
      interview_answers: [],
      interview_context: [],
    });
    expect("interview_answers" in p).toBe(false);
    expect("interview_context" in p).toBe(false);
  });
});

describe("INTERVIEW_QUESTIONS", () => {
  test("is a curated set of at most 10, each fully formed", () => {
    expect(INTERVIEW_QUESTIONS.length).toBeGreaterThan(0);
    expect(INTERVIEW_QUESTIONS.length).toBeLessThanOrEqual(10);
    const ids = new Set(INTERVIEW_QUESTIONS.map((q) => q.id));
    expect(ids.size).toBe(INTERVIEW_QUESTIONS.length); // unique ids
    for (const q of INTERVIEW_QUESTIONS) {
      expect(q.prompt.length).toBeGreaterThan(0);
      expect(q.helper.length).toBeGreaterThan(0);
      expect(q.placeholder.length).toBeGreaterThan(0);
    }
  });
});

describe("synthesizeInterviewContext", () => {
  beforeEach(() => {
    completeChat.mockReset();
    logOpenRouterUsage.mockClear();
  });

  test("zero real answers → no model call, empty context", async () => {
    const out = await synthesizeInterviewContext({
      answers: [{ question: "Q", answer: "" }],
      voice: null,
      workspaceId: "ws1",
    });
    expect(out).toEqual({ answers: [], context: [] });
    expect(completeChat).not.toHaveBeenCalled();
  });

  test("real answers → forced tool call, returns distilled context + logs spend", async () => {
    completeChat.mockResolvedValue({
      text: "",
      finishReason: "tool_calls",
      usage: { prompt_tokens: 200, completion_tokens: 80 },
      toolArgs: { context: ["I cut a client's churn 40%.", "  ", "I write for solo founders."] },
    });
    const out = await synthesizeInterviewContext({
      answers: [{ question: "A proud result?", answer: "Cut churn 40% for a client." }],
      voice: null,
      workspaceId: "ws1",
    });
    expect(out.answers).toHaveLength(1);
    expect(out.context).toEqual(["I cut a client's churn 40%.", "I write for solo founders."]);
    const call = completeChat.mock.calls[0][0];
    expect(call.forceTool).toBe("report_interview_context");
    expect(call.tools).toHaveLength(1);
    expect(logOpenRouterUsage).toHaveBeenCalledWith(
      "voice_interview",
      expect.any(String),
      expect.anything(),
      "ws1",
    );
  });

  test("the voice profile is passed into the synthesis prompt when present", async () => {
    completeChat.mockResolvedValue({ text: "", toolArgs: { context: ["A statement."] } });
    await synthesizeInterviewContext({
      answers: [{ question: "Q", answer: "A" }],
      voice: { summary: "Blunt SaaS founder voice", tone: ["direct"] } as never,
      workspaceId: "ws1",
    });
    const userMsg = completeChat.mock.calls[0][0].messages[1].content as string;
    expect(userMsg).toContain("VOICE PROFILE");
    expect(userMsg).toContain("Blunt SaaS founder voice");
  });

  // ---------------------------------------------------------------------------
  // REGRESSION: malformed tool output used to return { context: [] } as a
  // silent "success" — the route then persisted interview_context:[] as a
  // 200, which collapsed VoiceInterviewCard into an unreachable state (no
  // summary box because context is empty, no form because `expanded` had
  // already flipped false, no "Edit answers" button because that only shows
  // when context.length > 0). The user did their part (answered questions);
  // a malformed model result is our failure, not theirs, and must not be
  // saved as if it succeeded.
  // ---------------------------------------------------------------------------
  test("REGRESSION: malformed tool output retries once, then throws instead of silently succeeding", async () => {
    completeChat
      .mockResolvedValueOnce({ text: "prose", toolArgs: null })
      .mockResolvedValueOnce({ text: "prose", toolArgs: null });
    await expect(
      synthesizeInterviewContext({
        answers: [{ question: "Q", answer: "A" }],
        voice: null,
        workspaceId: "ws1",
      }),
    ).rejects.toThrow(/couldn't build context/i);
    expect(completeChat).toHaveBeenCalledTimes(2);
  });

  test("empty {context:[]} on the first attempt, real context on the retry → succeeds", async () => {
    completeChat
      .mockResolvedValueOnce({ text: "", toolArgs: { context: [] } })
      .mockResolvedValueOnce({ text: "", toolArgs: { context: ["I write for solo founders."] } });
    const out = await synthesizeInterviewContext({
      answers: [{ question: "Q", answer: "A" }],
      voice: null,
      workspaceId: "ws1",
    });
    expect(out.context).toEqual(["I write for solo founders."]);
    expect(completeChat).toHaveBeenCalledTimes(2);
  });

  test("a usable result on the first attempt never retries", async () => {
    completeChat.mockResolvedValueOnce({
      text: "",
      toolArgs: { context: ["I cut a client's churn 40%."] },
    });
    const out = await synthesizeInterviewContext({
      answers: [{ question: "Q", answer: "A" }],
      voice: null,
      workspaceId: "ws1",
    });
    expect(out.context).toEqual(["I cut a client's churn 40%."]);
    expect(completeChat).toHaveBeenCalledTimes(1);
  });
});
