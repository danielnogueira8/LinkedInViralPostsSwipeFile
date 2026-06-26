import Anthropic from "@anthropic-ai/sdk";
import type { AgentEvent, Artifact } from "@/lib/agent/run";
import type { ChatMessage } from "@/lib/openrouter";

// ---------------------------------------------------------------------------
// Live-model prompt-eval harness (Tier 3).
//
// Unlike the stubbed suite (which mocks streamChat and asserts loop mechanics),
// this runs the REAL agent loop against the REAL chat model so we can test
// whether the model actually FOLLOWS the system prompt — date honesty, exact
// counts, voice rules, etc. To stay deterministic about DATA while exercising
// real REASONING, the TOOLS are stubbed (fixed fixtures) but the model is not.
//
// Because prompt-following is fuzzy (you can't string-match "did it imply the
// post is newer than it is"), each case is graded by an LLM judge — a separate
// model (Claude, via the Anthropic SDK) from the one under test (GLM, via
// OpenRouter), so a model never grades itself.
//
// This file is imported only by *.live.test.ts, which the runner skips unless
// RUN_LIVE_EVALS=1 and the required keys are present (see shouldRunLiveEvals).
// ---------------------------------------------------------------------------

// True only when explicitly opted in AND both keys exist. The model under test
// needs OPENROUTER_API_KEY; the judge needs ANTHROPIC_API_KEY. Missing either →
// the suite skips cleanly so normal `npm run test:evals` is never affected.
export function shouldRunLiveEvals(): { run: boolean; reason: string } {
  if (process.env.RUN_LIVE_EVALS !== "1") {
    return { run: false, reason: "RUN_LIVE_EVALS!=1 (opt-in only)" };
  }
  if (!process.env.OPENROUTER_API_KEY) {
    return { run: false, reason: "OPENROUTER_API_KEY not set (model under test)" };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return { run: false, reason: "ANTHROPIC_API_KEY not set (judge)" };
  }
  return { run: true, reason: "" };
}

// Fixed tool fixtures for one scenario: map of tool name → result the agent
// loop receives when the model calls that tool. Anything not listed returns a
// generic { ok: true }, matching the stubbed suite's behavior.
export type ToolFixtures = Record<string, Record<string, unknown>>;

export type LiveRunResult = {
  // Everything the user would SEE: the final assistant text + any artifact
  // bodies (drafts/hooks), joined so the judge sees the full deliverable.
  finalText: string;
  artifacts: Artifact[];
  toolCalls: { name: string; args: string }[];
  done: boolean;
  errored: boolean;
};

// Run the REAL agent loop against the REAL model with stubbed tools. Returns
// what the user would see, for the judge to grade.
//
// We mock at call time via vitest's vi.mock in the test file (hoisted); here we
// just import runAgent lazily and drive it. The test file is responsible for
// mocking @/lib/agent/tools (runTool → fixtures) and @/lib/openrouter's
// logOpenRouterUsage (→ no-op, so no Supabase write), while leaving streamChat
// REAL. See prompt-evals.live.test.ts.
export async function runLiveAgent(
  userMessage: string,
  history: ChatMessage[] = [],
): Promise<LiveRunResult> {
  const { runAgent } = await import("@/lib/agent/run");

  const fullHistory: ChatMessage[] = [
    ...history,
    { role: "user", content: userMessage },
  ];

  const events: AgentEvent[] = [];
  for await (const ev of runAgent({
    history: fullHistory,
    workspaceId: "live-eval-workspace",
    // No chatId → no cancel polling / DB reads.
  })) {
    events.push(ev);
  }

  let finalText = "";
  const artifacts: Artifact[] = [];
  const toolCalls: { name: string; args: string }[] = [];
  let done = false;
  let errored = false;
  for (const ev of events) {
    if (ev.type === "tool_start") toolCalls.push({ name: ev.name, args: ev.args });
    else if (ev.type === "artifact") artifacts.push(ev.artifact);
    else if (ev.type === "error") errored = true;
    else if (ev.type === "done") {
      done = true;
      finalText = ev.message.content;
    }
  }
  return { finalText, artifacts, toolCalls, done, errored };
}

// The full deliverable the user sees: assistant text + every artifact body.
// The judge grades this, not just finalText, since posts/hooks live in
// artifacts (render_* tools), not the chat text.
export function visibleDeliverable(r: LiveRunResult): string {
  const parts = [r.finalText.trim()];
  for (const a of r.artifacts) {
    parts.push(`[${a.kind} card${a.title ? `: ${a.title}` : ""}]\n${a.body}`);
  }
  return parts.filter(Boolean).join("\n\n");
}

export type Verdict = { pass: boolean; reason: string };

// LLM-as-judge: grade a deliverable against a single, concrete rule. The judge
// is Claude (independent from GLM under test). The rubric is phrased so the
// judge returns strict JSON we can parse; we default to FAIL on any parse/SDK
// error so a flaky judge can't produce a false green.
export async function judge(opts: {
  userMessage: string;
  deliverable: string;
  rule: string;
}): Promise<Verdict> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const system =
    "You are a strict QA grader for an AI LinkedIn-ghostwriting assistant. " +
    "You are given the USER's request, the ASSISTANT's full visible reply, and " +
    "a single RULE. Decide ONLY whether the reply satisfies that rule — ignore " +
    "everything else (style, quality, other rules). Be literal and skeptical: " +
    "if the rule is violated even subtly, fail it. Reply with STRICT JSON only, " +
    'no prose: {"pass": true|false, "reason": "<one sentence>"}.';
  const user =
    `USER REQUEST:\n${opts.userMessage}\n\n` +
    `ASSISTANT REPLY:\n${opts.deliverable}\n\n` +
    `RULE TO CHECK:\n${opts.rule}`;

  try {
    const res = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 300,
      system,
      messages: [{ role: "user", content: user }],
    });
    const text = res.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { pass: false, reason: `Judge returned no JSON: ${text.slice(0, 120)}` };
    const parsed = JSON.parse(match[0]) as { pass?: unknown; reason?: unknown };
    return {
      pass: parsed.pass === true,
      reason: typeof parsed.reason === "string" ? parsed.reason : "(no reason)",
    };
  } catch (e) {
    // Fail closed: a judge error must not pass silently.
    return { pass: false, reason: `Judge error: ${(e as Error).message}` };
  }
}
